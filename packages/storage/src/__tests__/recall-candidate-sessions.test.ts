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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import type { StoredMessage } from '@maka/core/session';
import { createSessionStore } from '../session-store.js';
import { createSqliteRuntimeStore, type SqliteRuntimeStore } from '../sqlite-runtime-store.js';

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

interface Stores {
  readonly root: string;
  readonly sessions: ReturnType<typeof createSessionStore>;
  readonly runtime: SqliteRuntimeStore;
}

async function withStores(prefix: string, body: (stores: Stores) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const sessions = createSessionStore(root);
  const runtime = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  try {
    await body({ root, sessions, runtime });
  } finally {
    runtime.close();
    await sessions.close?.();
    await rm(root, { recursive: true, force: true });
  }
}

function userMessage(id: string, text: string, ts: number): StoredMessage {
  return { type: 'user', id, turnId: `turn-${id}`, ts, text } as StoredMessage;
}

/**
 * A Session written before the ledger: `create` marks every new Session as
 * ledger-born, so the marker is removed the way an upgraded workspace has it.
 */
async function makeLegacySession(stores: Stores, name: string): Promise<string> {
  const session = await stores.sessions.create(makeInput({ name }));
  const db = new DatabaseSync(join(stores.root, 'runtime.sqlite'));
  try {
    db.prepare(
      "UPDATE session_metadata SET payload_json = json_remove(payload_json, '$.transcriptLedgerVersion') WHERE session_id = ?",
    ).run(session.id);
  } finally {
    db.close();
  }
  return session.id;
}

function textEvent(sessionId: string, runId: string, id: string, text: string): RuntimeEvent {
  return {
    id,
    invocationId: runId,
    runId,
    sessionId,
    turnId: `turn-${runId}`,
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'text', text },
  };
}

describe('recall candidate Sessions over the ledger', () => {
  test('a Session is offered when one of its event payloads contains a folded term', async () => {
    await withStores('maka-recall-ledger-', async ({ sessions, runtime }) => {
      const hit = await sessions.create(makeInput({ name: 'hit' }));
      const miss = await sessions.create(makeInput({ name: 'miss' }));
      await runtime.appendRuntimeEvent(
        hit.id,
        'run-1',
        textEvent(hit.id, 'run-1', 'e1', 'The Context window'),
      );
      await runtime.appendRuntimeEvent(
        miss.id,
        'run-2',
        textEvent(miss.id, 'run-2', 'e2', 'unrelated'),
      );

      const offered = await runtime.listSessionsWithRuntimeEventText(
        [hit.id, miss.id],
        ['context'],
      );
      assert.deepEqual(offered, [hit.id]);
      await assert.rejects(
        () => runtime.listSessionsWithRuntimeEventText([hit.id], ['Context']),
        /must be folded/u,
      );
    });
  });

  test('a record SQLite cannot fold is offered whatever the term', async () => {
    await withStores('maka-recall-ledger-unicode-', async ({ sessions, runtime }) => {
      const session = await sessions.create(makeInput());
      await runtime.appendRuntimeEvent(
        session.id,
        'run-1',
        textEvent(session.id, 'run-1', 'e1', 'ĐÀ NẴNG'),
      );
      assert.deepEqual(
        await runtime.listSessionsWithRuntimeEventText([session.id], ['nothing-here']),
        [session.id],
      );
    });
  });

  test('a Session with an in-flight partial stream is offered unconditionally', async () => {
    await withStores('maka-recall-ledger-partial-', async ({ sessions, runtime }) => {
      const session = await sessions.create(makeInput());
      await runtime.appendRuntimePartialBatch(session.id, 'run-1', [
        {
          ...textEvent(session.id, 'run-1', 'p1', 'streaming so far'),
          partial: true,
          refs: { providerEventId: 'provider-1' },
        },
      ]);
      assert.deepEqual(
        await runtime.listSessionsWithRuntimeEventText([session.id], ['nothing-here']),
        [session.id],
      );
    });
  });

  test('the corpus count covers only kinds that project to searchable messages', async () => {
    await withStores('maka-recall-ledger-count-', async ({ sessions, runtime }) => {
      const session = await sessions.create(makeInput());
      await runtime.appendRuntimeEvent(
        session.id,
        'run-1',
        textEvent(session.id, 'run-1', 'e1', 'a'),
      );
      await runtime.appendRuntimeEvent(session.id, 'run-1', {
        ...textEvent(session.id, 'run-1', 'e2', 'reasoning'),
        content: { kind: 'thinking', text: 'reasoning' },
      });
      assert.equal(await runtime.countRuntimeEventMessages([session.id]), 1);
      assert.equal(await runtime.countRuntimeEventMessages([]), 0);
    });
  });
});

describe('recall candidate Sessions over pre-ledger transcripts', () => {
  test('only Sessions the ledger does not own are scanned', async () => {
    await withStores('maka-recall-legacy-', async (stores) => {
      const legacy = await makeLegacySession(stores, 'legacy');
      const converted = await stores.sessions.create(makeInput({ name: 'converted' }));
      await stores.sessions.appendMessage(legacy, userMessage('m1', 'The React component', 10));
      await stores.sessions.appendMessage(
        converted.id,
        userMessage('m2', 'The React component', 20),
      );

      const offered = await stores.sessions.listLegacyTranscriptCandidateSessions!(
        [legacy, converted.id],
        ['react'],
      );
      assert.deepEqual(offered, [legacy]);
      assert.equal(await stores.sessions.countLegacyTranscriptMessages!([legacy, converted.id]), 1);
    });
  });

  test('a folded term reaches records in either storage form', async () => {
    await withStores('maka-recall-legacy-forms-', async (stores) => {
      const inline = await makeLegacySession(stores, 'inline');
      const chunked = await makeLegacySession(stores, 'chunked');
      const filler = 'x'.repeat(80 * 1024);
      await stores.sessions.appendMessage(inline, userMessage('m1', 'ĐÀ NẴNG trip', 10));
      await stores.sessions.appendMessage(
        chunked,
        userMessage('big', `${filler} 上下文窗口 ${filler}`, 10),
      );

      const search = (term: string) =>
        stores.sessions.listLegacyTranscriptCandidateSessions!([inline, chunked], [term]);
      assert.deepEqual(
        (await search('上下文窗口'))?.sort(),
        [chunked, inline].sort(),
        'unstable inline record rides along',
      );
      assert.deepEqual(await search('đà nẵng'), [inline]);
      await assert.rejects(() => search('Context'), /must be folded/u);
    });
  });

  /**
   * A chunk set that does not reassemble to the bytes the payload recorded
   * would be matched on a body shorter than the record, so the term could sit
   * in the part that is missing. Declining is the only answer that keeps the
   * result a superset.
   */
  test('a chunk set that does not reassemble declines the fast path', async () => {
    await withStores('maka-recall-legacy-torn-', async (stores) => {
      const session = await makeLegacySession(stores, 'torn');
      const filler = 'x'.repeat(80 * 1024);
      await stores.sessions.appendMessage(session, userMessage('big', `${filler} 上下文窗口`, 10));
      assert.deepEqual(
        await stores.sessions.listLegacyTranscriptCandidateSessions!([session], ['上下文窗口']),
        [session],
      );

      const db = new DatabaseSync(join(stores.root, 'runtime.sqlite'));
      try {
        db.prepare(
          'DELETE FROM session_message_chunks WHERE session_id = ? AND chunk_index = (SELECT max(chunk_index) FROM session_message_chunks WHERE session_id = ?)',
        ).run(session, session);
      } finally {
        db.close();
      }
      assert.equal(
        await stores.sessions.listLegacyTranscriptCandidateSessions!([session], ['上下文窗口']),
        undefined,
      );
    });
  });

  test('an empty request is answered without touching storage', async () => {
    await withStores('maka-recall-legacy-empty-', async (stores) => {
      assert.deepEqual(await stores.sessions.listLegacyTranscriptCandidateSessions!([], ['x']), []);
      assert.equal(await stores.sessions.countLegacyTranscriptMessages!([]), 0);
    });
  });
});
