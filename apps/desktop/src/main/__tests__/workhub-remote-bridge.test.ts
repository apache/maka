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
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WORKHUB_COORDINATION_SESSION_ID as sessionId, type StoredMessage } from '@maka/core/session';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import type { BotIncomingMessage } from '@maka/runtime/bots';
import type { InteractionPendingSnapshot, SessionContinuitySnapshot, SubscriptionFrame } from '@maka/runtime-host/protocol';
import { createWorkHubRemoteBridge } from '../workhub-remote-bridge.js';
import { AsyncFrameQueue, runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

type Deps = Parameters<typeof createWorkHubRemoteBridge>[0];
const message = (chatId: string, text: string, sourceMessageId = text): BotIncomingMessage => ({ platform: 'qq', chatId, userId: 'owner', userName: 'Owner', isGroup: false, text, sourceMessageId, receivedAt: 1 });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'workhub-remote-'));
  const sends: { chat: string; text: string }[] = [];
  const starts: { turnId: string; text: string }[] = [];
  const answers: unknown[] = [];
  const errors: unknown[] = [];
  let rows: StoredMessage[] = [];
  let events = new AsyncFrameQueue();
  let pending: InteractionPendingSnapshot[] = [];
  let mode: 'task' | 'workhub' = 'workhub';
  let completed = false;
  let busy = false;
  const snapshot = (): SessionContinuitySnapshot => ({ schemaVersion: 1, session: { sessionId, metadataRevision: 1, status: 'active', createdAt: 1, isArchived: false }, projectionRevision: 1, rootTurn: null, goal: null, queue: { messages: [] }, interactions: { pending } } as unknown as SessionContinuitySnapshot);
  const client: Deps['client'] = {
    openSession: async (id) => {
      assert.equal(id, sessionId);
      const ownEvents = events;
      return runtimeHostSessionFixture({ snapshot: snapshot(), events: ownEvents,
        transcriptWatermark: () => rows.length ? rows.length - 1 : null,
        loadTranscriptPage: async (input) => ({ kind: 'page', sessionId, direction: 'newer', throughSequence: rows.length - 1, rawBytes: 0, fragments: [], nextCursor: null, endsAtTurnBoundary: true, anchor: input.anchorSequence } as never),
        decodeTranscriptPage: async (page) => ({ messages: rows.map((message, identity) => ({ message, identity })).filter(({ identity }) => identity > ((page as unknown as { anchor: number | null }).anchor ?? -1)), nextCursor: null }),
        close: async () => { ownEvents.end(); },
      });
    },
    resolveWorkHubCoordinationSession: async () => ({ sessionId }),
    answerWorkHubCoordination: async (input) => { if (busy) throw new RuntimeHostOperationError('workhub.coordination.answer', 'session_busy', 'busy'); starts.push(input); return { turnId: input.turnId }; },
    answerInteraction: async (input) => { answers.push(input); pending = []; return {} as never; },
    queryInteraction: async (input) => pending.find((item) => item.interactionId === input.interactionId)!,
    queryTurn: async ({ turnId }) => ({ sessionId, turnId, runId: 'run', status: completed ? 'completed' : 'running' } as never),
    subscribeSessionCatalogChanges: () => () => {},
  };
  const deps: Deps = { client, statePath: join(directory, 'routes.json'), readMode: async () => mode,
    botRegistry: { sendMessage: async (_platform, chat, text) => { sends.push({ chat, text }); return 'sent'; } }, onError: (error) => { errors.push(error); } };
  let bridge = createWorkHubRemoteBridge(deps);
  const tick = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 2)); };
  return {
    sends, starts, answers, errors, get bridge() { return bridge; },
    setBusy(value: boolean) { busy = value; },
    setMode(value: typeof mode) { mode = value; },
    async project(value: InteractionPendingSnapshot[]) { pending = value; events.push({ kind: 'subscription.session_projection', snapshot: snapshot() } as SubscriptionFrame); await tick(); },
    async transcript(value: StoredMessage[], done = true) { rows = value; completed = done; events.push({ kind: 'subscription.transcript_advanced', throughSequence: rows.length - 1 } as SubscriptionFrame); await tick(); },
    async restart() { await bridge.close(); events = new AsyncFrameQueue(); bridge = createWorkHubRemoteBridge(deps); await tick(); },
    async close() { await bridge.close(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); },
  };
}
function question(turnId: string): InteractionPendingSnapshot {
  return { schemaVersion: 1, revision: 1, status: 'pending', outcome: null, sessionId, turnId, runId: 'run', interactionId: 'question-1', request: { kind: 'question', toolUseId: 'ask', questions: ['项目', '范围', '测试'].map((question) => ({ question, options: ['甲', '乙', '丙'].map((label) => ({ label })) })) } };
}
test('all chats use one WorkHub; questions route to their source and survive restart', async () => {
  const f = await fixture();
  try {
    assert.equal(await f.bridge.handle(message('one', '修改 Maka')), true);
    const turnId = f.starts[0]!.turnId;
    await f.project([question(turnId)]);
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0]!.chat, 'one');
    assert.ok(f.sends[0]!.text.includes('3. 测试'));
    await f.restart();
    assert.equal(f.sends.length, 1, 'recovery does not resend an already delivered question');
    await f.bridge.handle(message('two', 'ACC'));
    assert.equal(f.answers.length, 0, 'another chat cannot accidentally answer this request');
    await f.bridge.handle(message('one', 'AZC'));
    assert.equal(f.answers.length, 0);
    await f.bridge.handle(message('one', '133'));
    assert.deepEqual(f.answers, [{ sessionId, interactionId: 'question-1', answer: { kind: 'question', answers: ['甲', '丙', '丙'] } }]);
    assert.equal(f.starts.length, 2, 'answers resume the interaction instead of starting a new Turn');
  } finally { await f.close(); }
});
test('delegated asynchronous result returns to original chat after restart, never the last chat', async () => {
  const f = await fixture();
  try {
    await f.bridge.handle(message('one', '实现功能'));
    const firstTurn = f.starts[0]!.turnId;
    await f.bridge.handle(message('two', '其他事情'));
    const assignment = { type: 'workhub_coordination', kind: 'delegation_assigned', actionId: 'action-1', coordinationTurnId: firstTurn } as StoredMessage;
    await f.transcript([assignment]);
    await f.restart();
    await f.transcript([assignment,
      { type: 'user', id: 'feedback', turnId: 'feedback', ts: 1, text: 'result', origin: { kind: 'workhub_result', actionId: 'action-1', eventId: 'event', delegationId: 'd', targetSessionId: 'target', targetTurnId: 'target-turn' } },
      { type: 'assistant', id: 'reply', turnId: 'feedback', ts: 2, text: '功能完成', modelId: 'test' },
    ]);
    assert.deepEqual(f.sends, [{ chat: 'one', text: '功能完成' }]);
    await f.restart();
    assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});
test('task setting leaves the existing Bot Session route in charge', async () => {
  const f = await fixture();
  try { f.setMode('task'); assert.equal(await f.bridge.handle(message('one', 'hello')), false); assert.equal(f.starts.length, 0); }
  finally { await f.close(); }
});

test('busy WorkHub queues messages durably and dispatches after restart without changing their source', async () => {
  const f = await fixture();
  try {
    f.setBusy(true);
    await f.bridge.handle(message('one', '先做这个'));
    await f.bridge.handle(message('two', '再做那个'));
    assert.equal(f.starts.length, 0);
    assert.equal(f.sends.length, 2);
    f.setBusy(false);
    await f.restart();
    assert.equal(f.starts.length, 1);
    await f.project([]);
    assert.equal(f.starts.length, 2);
    assert.ok(f.starts[0]!.text.includes('先做这个'));
    assert.ok(f.starts[1]!.text.includes('再做那个'));
    await f.bridge.handle(message('one', '先做这个'));
    assert.equal(f.starts.length, 2, 'same incoming source message is not admitted twice');
  } finally { await f.close(); }
});
