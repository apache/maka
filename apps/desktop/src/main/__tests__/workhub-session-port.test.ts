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
import type { StoredMessage } from '@maka/core/session';
import type { DesktopTranscriptBatch } from '../../preload/transcript-contract.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import {
  createDesktopWorkHubSessionPort,
  projectWorkHubSessionTurns,
  type WorkHubDesktopSession,
} from '../../renderer/workhub-session-port.js';

function desktopSession(
  id: string,
  overrides: Partial<WorkHubDesktopSession> = {},
): WorkHubDesktopSession {
  return {
    id,
    name: id,
    labels: [],
    isArchived: false,
    status: 'active',
    runningTurnIds: [],
    projectId: 'project-maka',
    lastMessageAt: 1,
    ...overrides,
  };
}

const unusedTranscripts = {
  open: async () => {
    throw new Error('transcript is not used by this test');
  },
};

test('projects durable Session messages into an ordered WorkHub conversation', () => {
  const turns = projectWorkHubSessionTurns({
    target: { sessionId: 'payment' },
    messages: [
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 10, text: '检查重复投递' },
      {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 11,
        text: '已定位风险',
        modelId: 'test-model',
      },
      { type: 'user', id: 'user-2', turnId: 'turn-1', ts: 12, text: '再补充测试点' },
      {
        type: 'assistant',
        id: 'assistant-2',
        turnId: 'turn-1',
        ts: 13,
        text: '已补充测试点',
        modelId: 'test-model',
      },
      {
        type: 'turn_state',
        id: 'state-1',
        turnId: 'turn-1',
        ts: 14,
        status: 'completed',
        partialOutputRetained: true,
      },
    ],
  });

  assert.deepEqual(turns, [
    {
      messageId: 'user-1',
      target: { sessionId: 'payment' },
      turnId: 'turn-1',
      text: '检查重复投递',
      state: 'completed',
      result: '已定位风险',
      updatedAt: 10,
    },
    {
      messageId: 'user-2',
      target: { sessionId: 'payment' },
      turnId: 'turn-1',
      text: '再补充测试点',
      state: 'completed',
      result: '已补充测试点',
      updatedAt: 12,
    },
  ]);
});

test('desktop adapter rebuilds recent turns from the Session transcript and closes the read', async () => {
  const sessionId = desktopSessionKey({ hostId: 'local-host', sessionId: 'payment' });
  const messages: StoredMessage[] = [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 10, text: '检查重复投递' },
    {
      type: 'assistant',
      id: 'assistant-1',
      turnId: 'turn-1',
      ts: 11,
      text: '已定位风险',
      modelId: 'test-model',
    },
    {
      type: 'turn_state',
      id: 'state-1',
      turnId: 'turn-1',
      ts: 12,
      status: 'completed',
      partialOutputRetained: true,
    },
  ];
  let closes = 0;
  const adapter = createDesktopWorkHubSessionPort({
    sessions: {
      list: async () => [],
      listTurns: async () => [],
      create: async () => {
        throw new Error('not used');
      },
      send: async () => {
        throw new Error('not used');
      },
      stop: async () => {},
      subscribeChanges: () => () => {},
    },
    transcripts: {
      open: async (requestedSessionId, handler) => {
        assert.equal(requestedSessionId, sessionId);
        const fragments = messages.map((message, sequence) => {
          const data = new TextEncoder().encode(JSON.stringify(message));
          return {
            source: 'durable' as const,
            identity: sequence,
            order: null,
            byteOffset: 0,
            totalBytes: data.byteLength,
            data,
          };
        });
        handler({
          sessionId: 'payment',
          deliverySequence: 1,
          generation: 'generation-1',
          hostEpoch: 'epoch-1',
          durableThrough: 2,
          fragments,
          evictedDurableSequences: [],
          completedOverlayMessageIds: [],
          hasOlder: false,
          hasNewer: false,
          reset: true,
          ready: true,
        } satisfies DesktopTranscriptBatch);
        return {
          sessionId,
          generation: 'generation-1',
          hostEpoch: 'epoch-1',
          readThroughMessageId: null,
          loadBefore: async () => {},
          loadAround: async () => {},
          close: async () => {
            closes += 1;
          },
        };
      },
    },
    projectName: () => 'Maka',
    newTurnId: () => 'unused',
  });

  assert.deepEqual(await adapter.recentTurns([{ sessionId }]), [{
    messageId: 'user-1',
    target: { sessionId },
    turnId: 'turn-1',
    text: '检查重复投递',
    state: 'completed',
    result: '已定位风险',
    updatedAt: 10,
  }]);
  assert.equal(closes, 1);
});

test('desktop adapter cancels an unavailable transcript without hiding ready Sessions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unavailableId = desktopSessionKey({ hostId: 'local-host', sessionId: 'unavailable' });
  const readyId = desktopSessionKey({ hostId: 'local-host', sessionId: 'ready' });
  let cancellations = 0;
  const adapter = createDesktopWorkHubSessionPort({
    sessions: {
      list: async () => [],
      listTurns: async () => [],
      create: async () => { throw new Error('not used'); },
      send: async () => { throw new Error('not used'); },
      stop: async () => {},
      subscribeChanges: () => () => {},
    },
    transcripts: {
      open: async (sessionId, handler, registerCancellation) => {
        if (sessionId === unavailableId) {
          return await new Promise<never>((_resolve, reject) => {
            registerCancellation?.(() => {
              cancellations += 1;
              reject(new Error('cancelled unavailable transcript'));
            });
          });
        }
        const message: StoredMessage = {
          type: 'user', id: 'user-ready', turnId: 'turn-ready', ts: 10, text: '可用工作',
        };
        const data = new TextEncoder().encode(JSON.stringify(message));
        handler({
          sessionId: 'ready', deliverySequence: 1, generation: 'generation-ready',
          hostEpoch: 'epoch-ready', durableThrough: 0,
          fragments: [{
            source: 'durable', identity: 0, order: null, byteOffset: 0,
            totalBytes: data.byteLength, data,
          }],
          evictedDurableSequences: [], completedOverlayMessageIds: [],
          hasOlder: false, hasNewer: false, reset: true, ready: true,
        });
        return {
          sessionId: readyId, generation: 'generation-ready', hostEpoch: 'epoch-ready',
          readThroughMessageId: null, loadBefore: async () => {}, loadAround: async () => {},
          close: async () => {},
        };
      },
    },
    projectName: () => 'Maka',
    newTurnId: () => 'unused',
  });

  const turns = adapter.recentTurns([
    { sessionId: unavailableId },
    { sessionId: readyId },
  ]);
  await Promise.resolve();
  t.mock.timers.tick(5_000);

  assert.deepEqual(await turns, [{
    messageId: 'user-ready', target: { sessionId: readyId }, turnId: 'turn-ready',
    text: '可用工作', state: 'completed', updatedAt: 10,
  }]);
  assert.equal(cancellations, 1);
});

test('desktop adapter projects Session catalog facts without owning copies', async () => {
  const source = [
    desktopSession('ordinary', {
      name: '支付回调幂等性',
      status: 'running',
      runningTurnIds: ['turn-running'],
      lastMessageAt: 30,
      lastMessagePreview: '正在补充重复投递测试',
    }),
    desktopSession('side', {
      labels: ['mode:side_conversation'],
      lastMessageAt: 20,
    }),
    desktopSession('waiting', {
      status: 'waiting_for_user',
      runningTurnIds: ['turn-waiting'],
      lastMessageAt: 15,
    }),
    desktopSession('child', {
      subagent: {},
      lastMessageAt: 10,
    }),
  ];
  const adapter = createDesktopWorkHubSessionPort({
    transcripts: unusedTranscripts,
    sessions: {
      list: async () => source,
      listTurns: async () => [],
      create: async () => {
        throw new Error('not used');
      },
      send: async () => {
        throw new Error('not used');
      },
      stop: async () => {},
      subscribeChanges: () => () => {},
    },
    projectName: (projectId) => projectId === 'project-maka' ? 'Maka' : undefined,
    newTurnId: () => 'unused',
  });

  assert.deepEqual(await adapter.list(), [
    {
      target: { sessionId: 'ordinary' },
      projectName: 'Maka',
      sessionName: '支付回调幂等性',
      kind: 'ordinary',
      archived: false,
      state: 'running',
      latestResult: '正在补充重复投递测试',
      updatedAt: 30,
    },
    {
      target: { sessionId: 'side' },
      projectName: 'Maka',
      sessionName: 'side',
      kind: 'internal',
      archived: false,
      state: 'active',
      updatedAt: 20,
    },
    {
      target: { sessionId: 'waiting' },
      projectName: 'Maka',
      sessionName: 'waiting',
      kind: 'ordinary',
      archived: false,
      state: 'waiting_for_user',
      updatedAt: 15,
    },
    {
      target: { sessionId: 'child' },
      projectName: 'Maka',
      sessionName: 'child',
      kind: 'subagent',
      archived: false,
      state: 'active',
      updatedAt: 10,
    },
  ]);
});

test('desktop adapter delegates create, send, and invalidation to Session APIs', async () => {
  const calls: unknown[] = [];
  let onChanged: (() => void) | undefined;
  const adapter = createDesktopWorkHubSessionPort({
    transcripts: unusedTranscripts,
    sessions: {
      list: async () => [desktopSession('created', {
        status: 'running',
        runningTurnIds: ['turn-new'],
      })],
      listTurns: async () => [],
      create: async (input) => {
        calls.push(['create', input]);
        return desktopSession('created', { name: input.name });
      },
      send: async (sessionId, command) => {
        calls.push(['send', sessionId, command]);
        return { ok: true, turnId: command.turnId };
      },
      stop: async (sessionId, input) => {
        calls.push(['stop', sessionId, input]);
      },
      subscribeChanges: (handler) => {
        onChanged = handler;
        return () => calls.push(['unsubscribe']);
      },
    },
    projectName: () => 'Maka',
    newTurnId: () => 'turn-new',
  });

  const created = await adapter.create({ name: '实现导出发票 PDF 功能' });
  const turn = await adapter.submit(created.target, '实现导出发票 PDF 功能');
  await adapter.stop(created.target, 'turn-new');
  let invalidations = 0;
  const unsubscribe = adapter.subscribe(() => {
    invalidations += 1;
  });
  onChanged?.();
  unsubscribe();

  assert.equal(created.kind, 'ordinary');
  assert.deepEqual(turn, { turnId: 'turn-new' });
  assert.equal(invalidations, 1);
  assert.deepEqual(calls, [
    ['create', { name: '实现导出发票 PDF 功能' }],
    ['send', 'created', { type: 'send', turnId: 'turn-new', text: '实现导出发票 PDF 功能' }],
    ['stop', 'created', { source: 'stop_button', expectedTurnId: 'turn-new' }],
    ['unsubscribe'],
  ]);
});

test('desktop adapter preserves when Session delivery steered an existing root Turn', async () => {
  const adapter = createDesktopWorkHubSessionPort({
    transcripts: unusedTranscripts,
    sessions: {
      list: async () => [],
      listTurns: async () => [],
      create: async () => {
        throw new Error('not used');
      },
      send: async (_sessionId, command) => ({
        ok: true,
        turnId: command.turnId,
        steered: true,
      }),
      stop: async () => {},
      subscribeChanges: () => () => {},
    },
    projectName: () => 'Maka',
    newTurnId: () => 'turn-steered',
  });

  assert.deepEqual(
    await adapter.submit({ sessionId: 'busy' }, '补充已有执行流'),
    { turnId: 'turn-steered', steered: true },
  );
});

test('desktop adapter binds stop to the root Turn owned by the WorkHub submission', async () => {
  const stopped: unknown[] = [];
  const adapter = createDesktopWorkHubSessionPort({
    transcripts: unusedTranscripts,
    sessions: {
      list: async () => [],
      listTurns: async () => [],
      create: async () => {
        throw new Error('not used');
      },
      send: async () => {
        throw new Error('not used');
      },
      stop: async (sessionId, input) => {
        stopped.push([sessionId, input]);
      },
      subscribeChanges: () => () => {},
    },
    projectName: () => 'Maka',
    newTurnId: () => 'unused',
  });

  await adapter.stop({ sessionId: 'payment' }, 'turn-workhub');

  assert.deepEqual(stopped, [[
    'payment',
    { source: 'stop_button', expectedTurnId: 'turn-workhub' },
  ]]);
});

test('desktop adapter derives stable origin evidence from the existing Session log', async () => {
  let reads = 0;
  const adapter = createDesktopWorkHubSessionPort({
    transcripts: unusedTranscripts,
    sessions: {
      list: async () => [],
      listTurns: async (sessionId) => {
        reads += 1;
        assert.equal(sessionId, 'payment');
        return [
          { userPromptPreview: '检查支付回调重复投递时的幂等性' },
          { userPromptPreview: '把风险按高、中、低分组' },
        ];
      },
      create: async () => {
        throw new Error('not used');
      },
      send: async () => {
        throw new Error('not used');
      },
      stop: async () => {},
      subscribeChanges: () => () => {},
    },
    projectName: () => 'Maka',
    newTurnId: () => 'unused',
  });

  const first = await adapter.routingEvidence([{ sessionId: 'payment' }]);
  const second = await adapter.routingEvidence([{ sessionId: 'payment' }]);

  assert.deepEqual(first, [{
    target: { sessionId: 'payment' },
    originPrompt: '检查支付回调重复投递时的幂等性',
  }]);
  assert.deepEqual(second, first);
  assert.equal(reads, 1);
});
