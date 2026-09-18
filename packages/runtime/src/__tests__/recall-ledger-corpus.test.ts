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

describe('recall over the corpus a live workspace actually has', () => {
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
