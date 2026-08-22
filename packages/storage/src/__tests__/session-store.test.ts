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
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import {
  EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_RECENT_SESSION_IDS,
  EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_SOURCE_IDS,
  createSessionStore,
  isSessionNotFoundError,
} from '../session-store.js';
import { OPERATIONAL_STATE_DATABASE_NAME } from '../operational-state-store.js';
import { createSqliteSessionMetadataStore } from '../sqlite-session-metadata-store.js';

describe('SQLite SessionStore', () => {
  test('ordinary Sessions have no external origin and provenance metadata is immutable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-external-origin-'));
    const store = createSessionStore(root);
    try {
      const ordinary = await store.create(makeInput());

      assert.equal(ordinary.externalOrigin, undefined);
      await assert.rejects(
        store.updateHeader(ordinary.id, { externalOrigin: undefined }),
        /external.*origin.*immutable/i,
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('looks up complete published import counts with bounded newest Session ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-external-origin-lookup-'));
    const store = createSessionStore(root);
    const importSession = async (sourceSessionId: string) =>
      store.createImportedSession(makeInput(), [], {
        adapterId: 'fake',
        sourceSessionId,
      });
    try {
      const duplicates = await Promise.all([
        importSession('duplicate'),
        importSession('duplicate'),
        importSession('duplicate'),
      ]);
      await Promise.all(
        duplicates.map((session, index) =>
          store.updateHeader(session.id, {
            createdAt: index === 0 ? 100 : 200,
            transcriptLedgerVersion: 1,
          }),
        ),
      );
      const archived = await importSession('archived');
      await store.updateHeader(archived.id, { transcriptLedgerVersion: 1 });
      const archivedSnapshot = await store.readHeaderRecordSnapshot(archived.id);
      await store.setSessionsArchivedVersioned(
        [{ sessionId: archived.id, expectedVersion: archivedSnapshot.revision }],
        true,
      );
      await importSession('staging');
      const deleted = await importSession('deleted');
      await store.updateHeader(deleted.id, { transcriptLedgerVersion: 1 });
      await store.remove(deleted.id);
      await store.create(makeInput({ parentSessionId: duplicates[0]!.id }));

      const result = await store.lookupExternalSessionImports(
        'fake',
        ['duplicate', 'archived', 'staging', 'deleted', 'ordinary', 'missing'],
        2,
      );
      const newestDuplicateIds = duplicates
        .slice(1)
        .map(({ id }) => id)
        .sort((left, right) => left.localeCompare(right));

      assert.deepEqual(result, [
        {
          sourceSessionId: 'duplicate',
          livePublishedImportCount: 3,
          recentSessionIds: newestDuplicateIds,
        },
        {
          sourceSessionId: 'archived',
          livePublishedImportCount: 1,
          recentSessionIds: [archived.id],
        },
      ]);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('bounds external import lookup source and recent-id requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-external-origin-bounds-'));
    const store = createSessionStore(root);
    try {
      await assert.rejects(
        store.lookupExternalSessionImports(
          'fake',
          Array.from(
            { length: EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_SOURCE_IDS + 1 },
            (_, index) => `source-${index}`,
          ),
          1,
        ),
        /at most .* source ids/,
      );
      await assert.rejects(
        store.lookupExternalSessionImports(
          'fake',
          ['source-1'],
          EXTERNAL_SESSION_IMPORT_LOOKUP_MAX_RECENT_SESSION_IDS + 1,
        ),
        /recent id limit must be between/,
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed when persisted external origin metadata is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-external-origin-invalid-'));
    const store = createSessionStore(root);
    let sessionId = '';
    try {
      const session = await store.create(makeInput());
      sessionId = session.id;
    } finally {
      await store.close?.();
    }

    const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    try {
      database
        .prepare(
          `UPDATE session_metadata
           SET payload_json = json_set(payload_json, '$.externalOrigin', json(?))
           WHERE session_id = ?`,
        )
        .run(JSON.stringify({ adapterId: '', sourceSessionId: 42 }), sessionId);
    } finally {
      database.close();
    }

    const reopened = createSessionStore(root);
    try {
      await assert.rejects(reopened.readHeaderSnapshot(sessionId), /malformed fields/);
    } finally {
      await reopened.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

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
          store.createImportedSession(makeInput({ name: `Staging Session ${index}` }), [], {
            adapterId: 'fake',
            sourceSessionId: `source-${index}`,
          }),
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
      assert.deepEqual(
        await store.readTranscriptMessagesSnapshot(session.id, {
          messageIds: ['message-4'],
          throughSequence: 3,
          maxBytes: 1024,
          maxMessages: 1,
        }),
        [],
      );
      assert.deepEqual(
        await store.readTranscriptMessagesSnapshot(session.id, {
          messageIds: ['message-4'],
          throughSequence: null,
          maxBytes: 1024,
          maxMessages: 1,
        }),
        [],
      );
      assert.deepEqual(
        await store.readTranscriptMessagesSnapshot(session.id, {
          messageIds: ['message-4'],
          throughSequence: 4,
          maxBytes: 1024,
          maxMessages: 1,
        }),
        [
          {
            type: 'user',
            id: 'message-4',
            turnId: 'turn-4',
            ts: 5,
            text: 'appended after the watermark',
          },
        ],
      );
      assert.deepEqual(
        await store.readTranscriptPageSnapshot(session.id, {
          direction: 'older',
          throughSequence: null,
          maxBytes: 64 * 1024,
          maxMessages: 2,
        }),
        { throughSequence: null, fragments: [], rawBytes: 0, next: null },
      );
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
      let continuation: {
        readonly position: number;
        readonly byteOffset: number | null;
      } | null = oversized.next;
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

  test('pages both new chunked messages and legacy inline v22 records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transcript-chunks-'));
    const message = {
      type: 'user' as const,
      id: 'message-large',
      turnId: 'turn-large',
      ts: 1,
      text: '三🙂x'.repeat(40_000),
    };
    const smallMessage = {
      type: 'user' as const,
      id: 'message-small',
      turnId: 'turn-small',
      ts: 2,
      text: 'small inline record',
    };
    let sessionId = '';
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      sessionId = session.id;
      await store.appendMessages(session.id, [message, smallMessage]);
      const fragments = [];
      let position = 0;
      let byteOffset: number | undefined;
      do {
        const page = await store.readTranscriptPageSnapshot(session.id, {
          direction: 'newer',
          throughSequence: 0,
          position,
          ...(byteOffset === undefined ? {} : { byteOffset }),
          maxBytes: 50_000,
          maxMessages: 1,
        });
        fragments.push(...page.fragments);
        position = page.next?.position ?? 1;
        byteOffset = page.next?.byteOffset ?? undefined;
      } while (position === 0);
      assert.deepEqual(
        JSON.parse(Buffer.concat(fragments.map(({ data }) => data)).toString('utf8')),
        message,
      );
      assert.equal(new Set(fragments.map(({ payloadDigest }) => payloadDigest)).size, 1);
      assert.match(fragments[0]?.payloadDigest ?? '', /^sha256:[0-9a-f]{64}$/);
    } finally {
      await store.close?.();
    }

    const path = join(root, OPERATIONAL_STATE_DATABASE_NAME);
    const legacy = new DatabaseSync(path);
    const legacyRecord = JSON.stringify(message);
    legacy
      .prepare(
        `
        UPDATE session_messages SET record_json = ?
        WHERE session_id = ? AND sequence = 0
      `,
      )
      .run(legacyRecord, sessionId);
    legacy.exec(`
      DROP TABLE agent_graph_epochs;
      DROP TABLE session_message_chunks;
      DROP TABLE session_message_payloads;
      ALTER TABLE session_metadata ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE session_metadata ADD COLUMN status_updated_at INTEGER;
      CREATE INDEX session_metadata_by_status
        ON session_metadata(status, status_updated_at DESC, session_id);
      DROP INDEX session_metadata_by_external_origin;
      ALTER TABLE session_metadata DROP COLUMN external_adapter_id;
      ALTER TABLE session_metadata DROP COLUMN external_source_session_id;
      UPDATE session_metadata_schema SET version = 22 WHERE scope = 'session_metadata';
    `);
    legacy.close();

    const migrated = createSessionStore(root);
    try {
      const page = await migrated.readTranscriptPageSnapshot(sessionId, {
        direction: 'older',
        throughSequence: 0,
        maxBytes: 50_000,
        maxMessages: 1,
      });
      assert.equal(page.fragments[0]?.data.byteLength, 50_000);
      assert.equal(
        page.fragments[0]?.totalBytes,
        Buffer.byteLength(JSON.stringify(message), 'utf8'),
      );
      assert.deepEqual(await migrated.readMessages(sessionId), [message, smallMessage]);
    } finally {
      await migrated.close?.();
    }

    await rm(root, { recursive: true, force: true });
  });

  test('rejects corrupt chunked messages on paged and ordinary reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transcript-corruption-'));
    const store = createSessionStore(root);
    let sessionId = '';
    try {
      const session = await store.create(makeInput());
      sessionId = session.id;
      await store.appendMessage(sessionId, {
        type: 'user',
        id: 'message-large',
        turnId: 'turn-large',
        ts: 1,
        text: 'x'.repeat(128 * 1024),
      });
    } finally {
      await store.close?.();
    }

    const path = join(root, OPERATIONAL_STATE_DATABASE_NAME);
    const inspect = new DatabaseSync(path);
    try {
      inspect
        .prepare(
          `
          UPDATE session_message_chunks
          SET data = zeroblob(length(data))
          WHERE session_id = ? AND sequence = 0 AND chunk_index = 1
        `,
        )
        .run(sessionId);
    } finally {
      inspect.close();
    }

    const corrupted = createSessionStore(root);
    try {
      await assert.rejects(
        corrupted.readTranscriptPageSnapshot(sessionId, {
          direction: 'newer',
          throughSequence: 0,
          position: 0,
          byteOffset: 64 * 1024,
          maxBytes: 1_000,
          maxMessages: 1,
        }),
        /incompatible/i,
      );
      const rewritten = new DatabaseSync(path);
      try {
        const chunk = rewritten
          .prepare(
            `
            SELECT data FROM session_message_chunks
            WHERE session_id = ? AND sequence = 0 AND chunk_index = 1
          `,
          )
          .get(sessionId) as { data: Uint8Array };
        rewritten
          .prepare(
            `
            UPDATE session_message_chunks SET sha256 = ?
            WHERE session_id = ? AND sequence = 0 AND chunk_index = 1
          `,
          )
          .run(createHash('sha256').update(chunk.data).digest('hex'), sessionId);
      } finally {
        rewritten.close();
      }
      const page = await corrupted.readTranscriptPageSnapshot(sessionId, {
        direction: 'newer',
        throughSequence: 0,
        position: 0,
        byteOffset: 64 * 1024,
        maxBytes: 1_000,
        maxMessages: 1,
      });
      assert.match(page.fragments[0]?.payloadDigest ?? '', /^sha256:[0-9a-f]{64}$/);
      await assert.rejects(corrupted.readMessages(sessionId), /incompatible/i);
    } finally {
      await corrupted.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('bounds transcript identity reconciliation before message materialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-transcript-reconciliation-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      const messages = Array.from({ length: 257 }, (_, index) => ({
        type: 'user' as const,
        id: `message-${index}`,
        turnId: `turn-${index}`,
        ts: index + 1,
        text: `text-${index}`,
      }));
      await store.appendMessages(session.id, messages);

      assert.deepEqual(
        await store.readTranscriptMessagesSnapshot(session.id, {
          messageIds: [...messages.map(({ id }) => id), messages[0]!.id],
          throughSequence: 256,
          maxBytes: 64 * 1024,
          maxMessages: 257,
        }),
        messages,
      );
      await assert.rejects(
        store.readTranscriptMessagesSnapshot(session.id, {
          messageIds: messages.map(({ id }) => id),
          throughSequence: 256,
          maxBytes: 64 * 1024,
          maxMessages: 256,
        }),
        /exceeds its message limit/,
      );
      await assert.rejects(
        store.readTranscriptMessagesSnapshot(session.id, {
          messageIds: [messages[0]!.id],
          throughSequence: 256,
          maxBytes: 1,
          maxMessages: 1,
        }),
        /exceeds its byte limit/,
      );
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

  test('pages turn contributions at a fixed transcript watermark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-turn-contributions-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(session.id, [
        { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'one' },
        {
          type: 'assistant',
          id: 'assistant-1',
          turnId: 'turn-1',
          ts: 2,
          text: 'answer',
          modelId: 'model-1',
        },
        {
          type: 'turn_state',
          id: 'state-1',
          turnId: 'turn-1',
          ts: 3,
          status: 'completed',
          partialOutputRetained: true,
        },
        { type: 'user', id: 'user-2', turnId: 'turn-2', ts: 4, text: 'two' },
      ]);

      const first = await store.readTurnContributionsSnapshot(session.id, null, 0, 1);
      assert.equal(first.throughSequence, 3);
      assert.equal(first.nextPosition, 3);
      assert.deepEqual(first.contributions, [
        {
          turnId: 'turn-1',
          firstSequence: 0,
          latestState: {
            sequence: 2,
            message: {
              type: 'turn_state',
              id: 'state-1',
              turnId: 'turn-1',
              ts: 3,
              status: 'completed',
              partialOutputRetained: true,
            },
          },
          userPromptPreview: 'one',
          hasAssistantMessage: true,
          hasAssistantOutput: true,
          hasToolResult: false,
          hasFailedToolResult: false,
          hasAbortNote: false,
        },
      ]);

      await store.appendMessage(session.id, {
        type: 'assistant',
        id: 'assistant-2',
        turnId: 'turn-2',
        ts: 5,
        text: 'later',
        modelId: 'model-1',
      });
      const second = await store.readTurnContributionsSnapshot(
        session.id,
        first.throughSequence,
        first.nextPosition!,
        1,
      );
      assert.equal(second.throughSequence, 3);
      assert.deepEqual(
        second.contributions.map((entry) => entry.turnId),
        ['turn-2'],
      );
      assert.equal(second.nextPosition, null);

      await store.appendMessage(session.id, {
        type: 'assistant',
        id: 'assistant-large',
        turnId: 'turn-large',
        ts: 6,
        text: 'x'.repeat(70 * 1024),
        modelId: 'model-1',
      });
      const chunked = await store.readTurnContributionsSnapshot(session.id, null, 0, 128);
      assert.deepEqual(
        chunked.contributions.find((entry) => entry.turnId === 'turn-large'),
        {
          turnId: 'turn-large',
          firstSequence: 5,
          latestState: null,
          userPromptPreview: null,
          hasAssistantMessage: true,
          hasAssistantOutput: true,
          hasToolResult: false,
          hasFailedToolResult: false,
          hasAbortNote: false,
        },
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('bounds turn contribution source scanning independently of turn count', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-turn-source-bound-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(
        session.id,
        Array.from({ length: 1_025 }, (_, index) => ({
          type: 'assistant' as const,
          id: `assistant-${index}`,
          turnId: 'turn-1',
          ts: index,
          text: 'x',
          modelId: 'model-1',
        })),
      );

      const first = await store.readTurnContributionsSnapshot(session.id, null, 0, 128);
      assert.equal(first.nextPosition, 1_024);
      assert.equal(first.contributions.length, 1);
      const second = await store.readTurnContributionsSnapshot(
        session.id,
        first.throughSequence,
        first.nextPosition!,
        128,
      );
      assert.equal(second.nextPosition, null);
      assert.equal(second.contributions.length, 1);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('samples a bounded prompt landmark index across the durable transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-turn-landmarks-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(
        session.id,
        Array.from({ length: 40 }, (_, index) => [
          {
            type: 'user' as const,
            id: `user-${index}`,
            turnId: `turn-${index}`,
            ts: index * 2,
            text: index === 20 ? 'x'.repeat(70 * 1024) : `prompt ${index}`,
          },
          {
            type: 'assistant' as const,
            id: `assistant-${index}`,
            turnId: `turn-${index}`,
            ts: index * 2 + 1,
            text: 'answer',
            modelId: 'model-1',
          },
        ]).flat(),
      );

      const snapshot = await store.readTurnLandmarksSnapshot(session.id, 8);

      assert.equal(snapshot.throughSequence, 79);
      assert.ok(snapshot.landmarks.length <= 8);
      assert.ok(snapshot.landmarks.length > 1);
      assert.equal(
        snapshot.landmarks.some((landmark) => landmark.turnId === 'turn-20'),
        false,
      );
      assert.deepEqual(
        [...snapshot.landmarks].sort((left, right) => left.sequence - right.sequence),
        snapshot.landmarks,
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps every prompt landmark when long turns fit within the landmark limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-turn-landmarks-long-turns-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(
        session.id,
        Array.from({ length: 3 }, (_, turnIndex) => [
          {
            type: 'user' as const,
            id: `user-${turnIndex}`,
            turnId: `turn-${turnIndex}`,
            ts: turnIndex * 10_000,
            text: `prompt ${turnIndex}`,
          },
          ...Array.from({ length: turnIndex === 0 ? 1_000 : 4_000 }, (_, messageIndex) => ({
            type: 'assistant' as const,
            id: `assistant-${turnIndex}-${messageIndex}`,
            turnId: `turn-${turnIndex}`,
            ts: turnIndex * 10_000 + messageIndex + 1,
            text: 'x',
            modelId: 'model-1',
          })),
        ]).flat(),
      );
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        const insert = database.prepare(`
          INSERT INTO core_root_turn_admissions(session_id, turn_id, admitted_at, record_json)
          VALUES (?, ?, ?, ?)
        `);
        for (let turnIndex = 0; turnIndex < 3; turnIndex += 1) {
          insert.run(
            session.id,
            `turn-${turnIndex}`,
            turnIndex,
            JSON.stringify({ userMessageId: `user-${turnIndex}` }),
          );
        }
      } finally {
        database.close();
      }

      const snapshot = await store.readTurnLandmarksSnapshot(session.id, 64);

      assert.deepEqual(
        snapshot.landmarks.map((landmark) => landmark.turnId),
        ['turn-0', 'turn-1', 'turn-2'],
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('keeps legacy prompts when newer turns have indexed admissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-session-turn-landmarks-mixed-'));
    const store = createSessionStore(root);
    try {
      const session = await store.create(makeInput());
      await store.appendMessages(
        session.id,
        Array.from({ length: 10 }, (_, index) => [
          {
            type: 'user' as const,
            id: `user-${index}`,
            turnId: `turn-${index}`,
            ts: index * 2,
            text: `prompt ${index}`,
          },
          {
            type: 'assistant' as const,
            id: `assistant-${index}`,
            turnId: `turn-${index}`,
            ts: index * 2 + 1,
            text: 'answer',
            modelId: 'model-1',
          },
        ]).flat(),
      );
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(`
          INSERT INTO core_root_turn_admissions(session_id, turn_id, admitted_at, record_json)
          VALUES (?, ?, ?, ?)
        `)
          .run(session.id, 'turn-9', 9, JSON.stringify({ userMessageId: 'user-9' }));
      } finally {
        database.close();
      }

      const snapshot = await store.readTurnLandmarksSnapshot(session.id, 8);

      assert.equal(snapshot.landmarks.length, 8);
      assert.equal(snapshot.landmarks[0]?.turnId, 'turn-0');
      assert.equal(snapshot.landmarks.at(-1)?.turnId, 'turn-9');
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

  test('reads back a legacy fake-backend session instead of migrating or rejecting it', async () => {
    // #3211: `'fake'` was retired as a live backend but never migrated out of
    // storage. Narrowing the header validator would make these rows decode as
    // malformed and rewriting them to `'ai-sdk'` would make an unrunnable task
    // look runnable, since `llmConnectionSlug` still points at nothing.
    //
    // The legacy row is seeded under the writer, not through `create`: `'fake'`
    // is a value only an older build could write, so a test that asks today's
    // creation path for one would be asserting a write that must not exist.
    const root = await mkdtemp(join(tmpdir(), 'maka-session-legacy-fake-'));
    const store = createSessionStore(root);
    let sessionId: string;
    try {
      sessionId = (await store.create(makeInput())).id;
    } finally {
      await store.close?.();
    }

    const legacy = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    try {
      const row = legacy
        .prepare(`SELECT payload_json FROM session_metadata WHERE session_id = ?`)
        .get(sessionId) as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.backend = 'fake';
      payload.llmConnectionSlug = 'fake';
      legacy
        .prepare(
          `UPDATE session_metadata
             SET payload_json = ?, backend = ?, llm_connection_slug = ?
           WHERE session_id = ?`,
        )
        .run(JSON.stringify(payload), 'fake', 'fake', sessionId);
    } finally {
      legacy.close();
    }

    const reopened = createSessionStore(root);
    try {
      const [header] = await reopened.listHeaders();
      assert.equal(header?.backend, 'fake');
      assert.equal(header?.llmConnectionSlug, 'fake');
      assert.equal((await reopened.readHeaderSnapshot(sessionId)).backend, 'fake');
    } finally {
      await reopened.close?.();
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
    llmConnectionSlug: 'test-connection',
    model: 'test-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}
