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
import { runRecall, type RecallDeps } from '@maka/core/recall';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import type { StoredMessage } from '@maka/core/session';
import { createSessionStore } from '@maka/storage/session-store';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { openRuntimeEventReadPersistence } from '@maka/storage/runtime-event-persistence';
import {
  countRecallSearchableMessages,
  listRecallCandidateSessions,
  RECALL_SYNTHETIC_TEXT_PATTERNS,
} from '../recall-candidates.js';
import { RuntimeReadModel } from '../runtime-read-model.js';
import { testInvocationOpenedEvent } from './invocation-fixture.js';

type Sessions = ReturnType<typeof createSessionStore>;
type Runtime = ReturnType<typeof createSqliteRuntimeStore>;

interface Workspace {
  readonly root: string;
  readonly sessions: Sessions;
  readonly runtime: Runtime;
  readonly readModel: RuntimeReadModel;
}

function makeInput(name: string): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    llmConnectionSlug: 'test-connection',
    model: 'test-model',
    permissionMode: 'ask',
    name,
    labels: [],
  };
}

async function withWorkspace(body: (workspace: Workspace) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-recall-ledger-corpus-'));
  const sessions = createSessionStore(root);
  const runtime = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  const readModel = new RuntimeReadModel({ runtimeEventStore: runtime });
  try {
    await body({ root, sessions, runtime, readModel });
  } finally {
    runtime.close();
    await sessions.close?.();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * One completed turn written the way a live turn writes it: an opening fact,
 * the turn's events, then the terminal fact. Nothing reaches `session_messages`
 * — which is the whole point, since a scan of that table is what used to answer
 * for a Session like this.
 */
async function seedLedgerTurn(
  workspace: Workspace,
  sessionId: string,
  runId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const turnId = `turn-${runId}`;
  const identity = { sessionId, invocationId: runId, runId, turnId };
  await workspace.runtime.appendRuntimeEvent(
    sessionId,
    runId,
    testInvocationOpenedEvent({ sessionId, runId, turnId, openedAt: 100 }),
  );
  const events: RuntimeEvent[] = [
    {
      ...identity,
      id: `${runId}-user`,
      ts: 101,
      partial: false,
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: userText },
    },
    {
      ...identity,
      id: `${runId}-assistant`,
      ts: 102,
      partial: false,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: assistantText },
    },
  ];
  for (const event of events) await workspace.runtime.appendRuntimeEvent(sessionId, runId, event);
  await workspace.runtime.appendRuntimeEvent(sessionId, runId, {
    ...identity,
    id: `${runId}-terminal`,
    ts: 103,
    partial: false,
    role: 'system',
    author: 'system',
    status: 'completed',
    actions: { endInvocation: true },
  });
}

/** A Session written before the ledger owned transcripts. */
async function seedLegacyTurn(
  workspace: Workspace,
  sessionId: string,
  messages: readonly StoredMessage[],
): Promise<void> {
  const db = new DatabaseSync(join(workspace.root, 'runtime.sqlite'));
  try {
    db.prepare(
      "UPDATE session_metadata SET payload_json = json_remove(payload_json, '$.transcriptLedgerVersion') WHERE session_id = ?",
    ).run(sessionId);
  } finally {
    db.close();
  }
  for (const message of messages) await workspace.sessions.appendMessage(sessionId, message);
}

function userMessage(id: string, text: string, ts: number): StoredMessage {
  return { type: 'user', id, turnId: `turn-${id}`, ts, text } as StoredMessage;
}

/**
 * The deps the Host composes, minus the candidate source. Transcripts are read
 * the way production reads them: through the read model, never from the
 * transcript tables.
 */
function scanDeps(workspace: Workspace): RecallDeps {
  return {
    listSessions: () => workspace.sessions.list(),
    readMessages: async (sessionId) => {
      const legacy = await workspace.sessions.readMessages(sessionId).catch(() => []);
      const ledger = await workspace.readModel.getSessionMessages(sessionId).catch(() => []);
      return ledger.length > 0 ? ledger : legacy;
    },
    getPrivacyContext: async () => ({ incognitoActive: false }),
    syntheticTextPatterns: RECALL_SYNTHETIC_TEXT_PATTERNS,
  };
}

function narrowedDeps(workspace: Workspace, onRead?: (sessionId: string) => void): RecallDeps {
  const base = scanDeps(workspace);
  const stores = { transcripts: workspace.sessions, ledger: workspace.runtime };
  return {
    ...base,
    readMessages: (sessionId, abortSignal) => {
      onRead?.(sessionId);
      return base.readMessages(sessionId, abortSignal);
    },
    listCandidateSessions: async ({ sessionIds, terms }) =>
      (await listRecallCandidateSessions(stores, sessionIds, terms)) ?? null,
    countSearchableMessages: async ({ sessionIds }) =>
      (await countRecallSearchableMessages(stores, sessionIds)) ?? null,
  };
}

function anchors(result: Awaited<ReturnType<typeof runRecall>>): string[] {
  assert.ok(result.ok, 'recall must succeed');
  return result.passages.map((passage) => passage.anchorMessageId).sort();
}

function unbatchedReadModel(workspace: Workspace): RuntimeReadModel {
  return new RuntimeReadModel({
    runtimeEventStore: new Proxy(workspace.runtime, {
      get(target, key) {
        if (key === 'readSessionRuntimeSnapshot') return undefined;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  });
}

describe('recall over the corpus a live workspace actually has', () => {
  test('reading Recall messages uses bounded SQL and decodes each durable event once', async (t) => {
    await withWorkspace(async (workspace) => {
      const session = await workspace.sessions.create(makeInput('long history'));
      const turns = 12;
      for (let index = 0; index < turns; index += 1) {
        await seedLedgerTurn(
          workspace,
          session.id,
          `run-${index}`,
          index < 10 ? 'deploy target' : 'unrelated',
          'ordinary response',
        );
      }
      const before = await runRecall(
        { terms: ['deploy'], limit: 10 },
        narrowedDeps({ ...workspace, readModel: unbatchedReadModel(workspace) }),
      );
      assert.ok(before.ok);
      assert.equal(before.passages.length, 10);

      const db = (workspace.runtime as unknown as { db: DatabaseSync }).db;
      const prepare = db.prepare.bind(db);
      let statements = 0;
      let parses = 0;
      t.mock.method(db, 'prepare', (sql: string) => {
        const statement = prepare(sql);
        return new Proxy(statement, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              if (key === 'get' || key === 'all' || key === 'iterate') statements += 1;
              return Reflect.apply(value, target, args);
            };
          },
        });
      });
      const parse = JSON.parse;
      t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
        parses += 1;
        return parse(...args);
      });
      try {
        const messages = await workspace.readModel.getSessionMessages(session.id);
        assert.equal(messages.filter((message) => message.type === 'user').length, turns);
      } finally {
        t.mock.restoreAll();
      }
      assert.ok(statements <= 6, `${turns} Turns issued ${statements} SQL reads`);
      assert.equal(parses, turns * 4, 'each opening, user, assistant and terminal decoded once');
      assert.deepEqual(
        await runRecall({ terms: ['deploy'], limit: 10 }, narrowedDeps(workspace)),
        before,
      );
    });
  });

  test('batch projection preserves active partials, child exclusion and Recall navigation', async () => {
    await withWorkspace(async (workspace) => {
      const session = await workspace.sessions.create(makeInput('mixed history'));
      await seedLedgerTurn(workspace, session.id, 'settled', 'deploy target', 'deployment notes');
      for (const runId of ['active-a', 'active-b', 'child']) {
        const identity = {
          sessionId: session.id,
          invocationId: runId,
          runId,
          turnId: `turn-${runId}`,
        };
        await workspace.runtime.appendRuntimeEvent(
          session.id,
          runId,
          testInvocationOpenedEvent({
            ...identity,
            openedAt: 200,
            ...(runId === 'child' ? { opening: { lineage: { parentRunId: 'active-a' } } } : {}),
          }),
        );
        await workspace.runtime.appendRuntimeEvent(session.id, runId, {
          ...identity,
          id: `${runId}-prompt`,
          ts: 199,
          partial: false,
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'deploy target' },
        });
        await workspace.runtime.appendRuntimePartialBatch(session.id, runId, [
          {
            ...identity,
            id: `${runId}-p1`,
            ts: 201,
            partial: true,
            role: 'model',
            author: 'agent',
            refs: { providerEventId: 'stream' },
            content: { kind: 'text', text: 'deploy ' },
          },
          {
            ...identity,
            id: `${runId}-p2`,
            ts: 202,
            partial: true,
            role: 'model',
            author: 'agent',
            refs: { providerEventId: 'stream' },
            content: { kind: 'text', text: 'in progress' },
          },
        ]);
      }
      const fallback = unbatchedReadModel(workspace);
      const expected = await fallback.getSessionView(session.id);
      const actual = await workspace.readModel.getSessionView(session.id);
      assert.deepEqual(actual, expected);
      assert.ok(
        actual.messages.some(
          (m) => m.type === 'assistant' && m.text.includes('deploy in progress'),
        ),
      );
      assert.ok(actual.events.every((event) => event.runId !== 'child'));
      for (const terms of [['deploy'], ['progress'], ['nothing-here']]) {
        assert.deepEqual(
          await runRecall({ terms, limit: 10 }, narrowedDeps(workspace)),
          await runRecall(
            { terms, limit: 10 },
            narrowedDeps({ ...workspace, readModel: fallback }),
          ),
        );
      }
      const reader = await openRuntimeEventReadPersistence({ workspaceRoot: workspace.root });
      try {
        assert.ok(reader.runtimeEventStore.readSessionRuntimeSnapshot);
        assert.deepEqual(
          await reader.runtimeEventStore.readSessionRuntimeSnapshot(session.id),
          await workspace.runtime.readSessionRuntimeSnapshot(session.id),
        );
      } finally {
        reader.close();
      }
    });
  });

  test('a failed batch snapshot is reported instead of retried as separate reads', async (t) => {
    await withWorkspace(async (workspace) => {
      t.mock.method(workspace.runtime, 'readSessionRuntimeSnapshot', async () => {
        throw new Error('snapshot unavailable');
      });
      const list = t.mock.method(workspace.runtime, 'listSessionInvocations');
      await assert.rejects(
        workspace.readModel.getSessionMessages('session'),
        /snapshot read failed/,
      );
      assert.equal(list.mock.callCount(), 0);
    });
  });

  test('a Session born on the ledger is reachable, and narrowing matches the full scan', async () => {
    await withWorkspace(async (workspace) => {
      const live = await workspace.sessions.create(makeInput('live'));
      const other = await workspace.sessions.create(makeInput('other'));
      const legacy = await workspace.sessions.create(makeInput('legacy'));
      await seedLedgerTurn(
        workspace,
        live.id,
        'run-1',
        '这个上下文窗口怎么设置',
        '在 provider 设置里改 context window',
      );
      await seedLedgerTurn(
        workspace,
        other.id,
        'run-2',
        '换个供应商要改什么',
        '模型名称和限制都要改',
      );
      await seedLegacyTurn(workspace, legacy.id, [
        userMessage('m1', '旧会话里也提到上下文窗口', 10),
      ]);

      // The table a candidate scan used to read holds nothing for the live
      // Sessions, so a scan of it alone would answer "no match" for both.
      assert.deepEqual(await workspace.sessions.readMessages(live.id), []);

      for (const terms of [['上下文'], ['context window'], ['供应商', '模型'], ['nothing-here']]) {
        const scanned = await runRecall({ terms, limit: 25 }, scanDeps(workspace));
        const narrowed = await runRecall({ terms, limit: 25 }, narrowedDeps(workspace));
        assert.deepEqual(anchors(narrowed), anchors(scanned), `diverged for ${terms.join('/')}`);
        assert.ok(scanned.ok && narrowed.ok);
        assert.deepEqual(
          narrowed.passages.map((passage) => [passage.anchorMessageId, passage.score]),
          scanned.passages.map((passage) => [passage.anchorMessageId, passage.score]),
          `ranking diverged for ${terms.join('/')}`,
        );
      }

      const found = await runRecall({ terms: ['上下文'] }, narrowedDeps(workspace));
      assert.ok(found.ok);
      assert.ok(found.passages.length >= 2, 'both the ledger and the legacy Session must be found');
      assert.equal(found.scannedFully, false, 'the fast path must be the one that answered');
    });
  });

  /**
   * The file name has to survive into the event payload for a payload scan to
   * offer the Session, and into the projection for the predicate to match it.
   * A double could satisfy either half alone.
   */
  test('a pasted file is reachable by name through the real stores', async () => {
    await withWorkspace(async (workspace) => {
      const session = await workspace.sessions.create(makeInput('screenshots'));
      const runId = 'run-shot';
      const turnId = `turn-${runId}`;
      const identity = { sessionId: session.id, invocationId: runId, runId, turnId };
      await workspace.runtime.appendRuntimeEvent(
        session.id,
        runId,
        testInvocationOpenedEvent({ sessionId: session.id, runId, turnId, openedAt: 100 }),
      );
      await workspace.runtime.appendRuntimeEvent(session.id, runId, {
        ...identity,
        id: `${runId}-user`,
        ts: 101,
        partial: false,
        role: 'user',
        author: 'user',
        content: {
          kind: 'text',
          text: '你看看',
          attachments: [
            {
              kind: 'image',
              name: 'pipeline-failure.png',
              mimeType: 'image/png',
              bytes: 2048,
              ref: {
                kind: 'session_file',
                sessionId: session.id,
                relativePath: 'art_01HQ8Z3K4M5N6P7Q8R9S0T1V2W',
              },
            },
          ],
        },
      });
      await workspace.runtime.appendRuntimeEvent(session.id, runId, {
        ...identity,
        id: `${runId}-end`,
        ts: 103,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: { endInvocation: true },
      });

      const options = { includeArchived: true, activeSessionId: session.id };
      for (const [name, deps] of [
        ['full', scanDeps(workspace)],
        ['narrowed', narrowedDeps(workspace)],
      ] as const) {
        const result = await runRecall({ terms: ['pipeline-failure'] }, deps, options);
        assert.ok(result.ok, name);
        assert.deepEqual(anchors(result), [`${runId}-user`], name);
        const material = result.passages[0]?.messages[0]?.materials?.[0];
        assert.equal(material?.name, 'pipeline-failure.png', name);
        assert.equal(
          material?.resource,
          'maka://runtime/attachments/art_01HQ8Z3K4M5N6P7Q8R9S0T1V2W',
          name,
        );
      }
    });
  });

  test('narrowing reads only the Sessions that can match', async () => {
    await withWorkspace(async (workspace) => {
      const hit = await workspace.sessions.create(makeInput('hit'));
      const miss = await workspace.sessions.create(makeInput('miss'));
      await seedLedgerTurn(workspace, hit.id, 'run-1', '上下文窗口', '在 provider 设置里改');
      await seedLedgerTurn(workspace, miss.id, 'run-2', '完全无关', '也无关');

      const read: string[] = [];
      const result = await runRecall(
        { terms: ['上下文'] },
        narrowedDeps(workspace, (sessionId) => read.push(sessionId)),
      );
      assert.ok(result.ok);
      assert.deepEqual(read, [hit.id]);
    });
  });
});
