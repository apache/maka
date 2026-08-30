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
import {
  createDesktopWorkHubCoordinationPort,
  projectWorkHubCoordinationTurns,
} from '../../renderer/workhub-coordination-port.js';

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

const noMessageExecutions = async () => ({
  resolutions: [] as Array<
    | { messageId: string; state: 'pending' }
    | { messageId: string; state: 'cancelled' }
    | { messageId: string; state: 'owned'; turnId: string; runId: string }
  >,
});

function transcriptsWith(messages: readonly StoredMessage[]) {
  return {
    open: async (sessionId: string, handler: (batch: DesktopTranscriptBatch) => void) => {
      const parsed = JSON.parse(sessionId) as [string, string];
      const fragments = messages.map((message, identity) => {
        const data = new TextEncoder().encode(JSON.stringify(message));
        return {
          source: 'durable' as const,
          identity,
          order: null,
          byteOffset: 0,
          totalBytes: data.byteLength,
          data,
        };
      });
      handler({
        sessionId: parsed[1],
        deliverySequence: 1,
        generation: 'generation-reconcile',
        hostEpoch: 'epoch-reconcile',
        durableThrough: messages.length - 1,
        fragments,
        evictedDurableSequences: [],
        completedOverlayMessageIds: [],
        hasOlder: false,
        hasNewer: false,
        reset: true,
        ready: true,
      });
      return {
        sessionId,
        generation: 'generation-reconcile',
        hostEpoch: 'epoch-reconcile',
        readThroughMessageId: null,
        loadBefore: async () => {},
        loadAround: async () => {},
        close: async () => {},
      };
    },
  };
}

test('projects the durable Coordination transcript into the WorkHub conversation', () => {
  assert.deepEqual(projectWorkHubCoordinationTurns([
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 10, text: 'What is next?' },
    {
      type: 'assistant',
      id: 'assistant-1',
      turnId: 'turn-1',
      ts: 11,
      text: 'Slice 3 is next.',
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
    {
      type: 'workhub_coordination',
      id: 'assignment-1',
      turnId: 'action-1',
      ts: 20,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: 'action-1',
      actionFingerprint: `sha256:${'a'.repeat(64)}`,
      coordinationTurnId: 'action-1',
      targetSessionId: 'payments',
      targetSessionName: 'Payments',
      targetTurnId: 'payments-turn',
      targetMessageId: 'payments-message',
      delegationId: 'payments-delegation',
      disposition: 'delegate_existing',
      userText: 'Continue payments',
    },
  ]), [{
    messageId: 'user-1',
    turnId: 'turn-1',
    text: 'What is next?',
    result: 'Slice 3 is next.',
    state: 'completed',
    updatedAt: 11,
  }, {
    messageId: 'assignment-1',
    turnId: 'action-1',
    text: 'Continue payments',
    state: 'completed',
    assignment: {
      delegationId: 'payments-delegation',
      targetSessionId: 'payments',
      targetSessionName: 'Payments',
      targetMessageId: 'payments-message',
      targetTurnId: 'payments-turn',
      feedbackState: 'accepted',
    },
    updatedAt: 20,
  }]);
});

test('Coordination transcript adapter emits an initial empty ready snapshot and closes cleanly', async () => {
  const sessionId = desktopSessionKey({ hostId: 'local-host', sessionId: 'coordination' });
  const snapshots: unknown[] = [];
  let closes = 0;
  const adapter = createDesktopWorkHubCoordinationPort({
    sessionId,
    transcripts: {
      open: async (requestedSessionId, handler) => {
        assert.equal(requestedSessionId, sessionId);
        handler({
          sessionId: 'coordination',
          deliverySequence: 1,
          generation: 'generation-1',
          hostEpoch: 'epoch-1',
          durableThrough: null,
          fragments: [],
          evictedDurableSequences: [],
          completedOverlayMessageIds: [],
          hasOlder: false,
          hasNewer: false,
          reset: true,
          ready: true,
        });
        return {
          sessionId,
          generation: 'generation-1',
          hostEpoch: 'epoch-1',
          readThroughMessageId: null,
          loadBefore: async () => {},
          loadAround: async () => {},
          close: async () => { closes += 1; },
        };
      },
    },
    record: async (input) => ({ turnId: input.turnId }),
    candidates: async () => ({
      candidateSetId: `sha256:${'a'.repeat(64)}`,
      candidates: [],
    }),
    act: async () => ({
      ok: true,
      result: {
        disposition: 'answer_here',
        coordinationTurnId: 'coordination-turn',
      },
    }),
  });

  const handle = await adapter.open((turns) => snapshots.push(turns), () => {});
  assert.deepEqual(snapshots, [[]]);
  await handle.close();
  assert.equal(closes, 1);
});

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
      queryMessageExecutions: noMessageExecutions,
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
      queryMessageExecutions: noMessageExecutions,
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
      queryMessageExecutions: noMessageExecutions,
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
  });

  assert.deepEqual(await adapter.list(), [
    {
      target: { sessionId: 'ordinary' },
      projectName: 'Maka',
      sessionName: '支付回调幂等性',
      kind: 'ordinary',
      archived: false,
      state: 'running',
      runningTurnIds: ['turn-running'],
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
      runningTurnIds: [],
      updatedAt: 20,
    },
    {
      target: { sessionId: 'waiting' },
      projectName: 'Maka',
      sessionName: 'waiting',
      kind: 'ordinary',
      archived: false,
      state: 'waiting_for_user',
      runningTurnIds: ['turn-waiting'],
      updatedAt: 15,
    },
    {
      target: { sessionId: 'child' },
      projectName: 'Maka',
      sessionName: 'child',
      kind: 'subagent',
      archived: false,
      state: 'active',
      runningTurnIds: [],
      updatedAt: 10,
    },
  ]);
});

test('desktop adapter rebuilds delegation feedback from the Message-owned execution Turn', async () => {
  const sessions = [
    desktopSession('accepted'),
    desktopSession('running', { status: 'running', runningTurnIds: ['turn-running'] }),
    desktopSession('stale-running'),
    desktopSession('recorded-running-only', { runningTurnIds: undefined }),
    desktopSession('waiting', {
      status: 'waiting_for_user',
      runningTurnIds: ['turn-waiting'],
    }),
    desktopSession('completed', {
      status: 'waiting_for_user',
      runningTurnIds: ['later-turn'],
    }),
    desktopSession('failed'),
    desktopSession('aborted'),
    desktopSession('cancelled'),
    desktopSession('recovering'),
  ];
  const turns = new Map<string, Array<{
    turnId: string;
    status: 'running' | 'completed' | 'failed' | 'aborted';
    statusSource: 'recorded';
  }>>([
    ['running', [{ turnId: 'turn-running', status: 'running', statusSource: 'recorded' }]],
    ['stale-running', [{
      turnId: 'turn-stale-running',
      status: 'running',
      statusSource: 'recorded',
    }]],
    ['recorded-running-only', [{
      turnId: 'turn-recorded-running-only',
      status: 'running',
      statusSource: 'recorded',
    }]],
    ['waiting', [{ turnId: 'turn-waiting', status: 'running', statusSource: 'recorded' }]],
    ['completed', [{ turnId: 'turn-completed', status: 'completed', statusSource: 'recorded' }]],
    ['failed', [{ turnId: 'turn-failed', status: 'failed', statusSource: 'recorded' }]],
    ['aborted', [{ turnId: 'turn-aborted', status: 'aborted', statusSource: 'recorded' }]],
  ]);
  const adapter = createDesktopWorkHubSessionPort({
    transcripts: unusedTranscripts,
    sessions: {
      list: async () => sessions,
      listTurns: async (sessionId) => {
        if (sessionId === 'recovering') throw new Error('Host is recovering');
        return turns.get(sessionId) ?? [];
      },
      queryMessageExecutions: async (sessionId, messageIds) => ({
        resolutions: sessionId === 'accepted'
          ? messageIds.map((messageId) => ({ messageId, state: 'pending' as const }))
          : sessionId === 'cancelled'
            ? messageIds.map((messageId) => ({ messageId, state: 'cancelled' as const }))
          : sessionId === 'recovering'
            ? []
            : messageIds.map((messageId) => ({
              messageId,
              state: 'owned' as const,
              turnId: `turn-${sessionId}`,
              runId: `run-${sessionId}`,
            })),
      }),
      create: async () => { throw new Error('not used'); },
      send: async () => { throw new Error('not used'); },
      stop: async () => {},
      subscribeChanges: () => () => {},
    },
    projectName: () => 'Maka',
  });
  const references = [
    ['accepted', 'turn-accepted'],
    ['running', 'turn-running'],
    ['stale-running', 'turn-stale-running'],
    ['recorded-running-only', 'turn-recorded-running-only'],
    ['waiting', 'turn-waiting'],
    ['completed', 'turn-completed'],
    ['failed', 'turn-failed'],
    ['aborted', 'turn-aborted'],
    ['cancelled', 'turn-cancelled'],
    ['recovering', 'turn-recovering'],
  ].map(([targetSessionId, targetTurnId]) => ({
    delegationId: `delegation-${targetSessionId}`,
    targetSessionId: targetSessionId!,
    targetMessageId: `message-${targetSessionId}`,
    targetTurnId: targetTurnId!,
  }));

  const feedback = await adapter.delegationFeedback(references);

  assert.deepEqual(feedback.map(({ delegationId, state }) => ({ delegationId, state })), [
    { delegationId: 'delegation-accepted', state: 'accepted' },
    { delegationId: 'delegation-running', state: 'running' },
    { delegationId: 'delegation-stale-running', state: 'accepted' },
    { delegationId: 'delegation-recorded-running-only', state: 'running' },
    { delegationId: 'delegation-waiting', state: 'waiting_for_user' },
    { delegationId: 'delegation-completed', state: 'completed' },
    { delegationId: 'delegation-failed', state: 'failed' },
    { delegationId: 'delegation-aborted', state: 'aborted' },
    { delegationId: 'delegation-cancelled', state: 'aborted' },
    { delegationId: 'delegation-recovering', state: 'recovering' },
  ]);
});

test('desktop adapter follows a delegated Message into its successor Turn', async () => {
  const targetSessionId = desktopSessionKey({ hostId: 'local-host', sessionId: 'payments' });
  const adapter = createDesktopWorkHubSessionPort({
    transcripts: transcriptsWith([{
      type: 'user',
      id: 'payment-message',
      turnId: 'successor-turn',
      ts: 2,
      text: 'Continue payment recovery',
      steeringEventId: 'payment-message',
    }]),
    sessions: {
      list: async () => [desktopSession(targetSessionId, {
        status: 'running',
        runningTurnIds: ['successor-turn'],
      })],
      listTurns: async () => [
        {
          turnId: 'admission-turn',
          status: 'completed',
          statusSource: 'recorded',
        },
        {
          turnId: 'successor-turn',
          status: 'running',
          statusSource: 'recorded',
        },
      ],
      queryMessageExecutions: async (_sessionId, messageIds) => ({
        resolutions: messageIds.map((messageId) => ({
          messageId,
          state: 'owned' as const,
          turnId: 'successor-turn',
          runId: 'successor-run',
        })),
      }),
      create: async () => { throw new Error('not used'); },
      send: async () => { throw new Error('not used'); },
      stop: async () => {},
      subscribeChanges: () => () => {},
    },
    projectName: () => 'Maka',
  });

  const references = [{
    delegationId: 'payment-delegation',
    targetSessionId,
    targetTurnId: 'admission-turn',
    targetMessageId: 'payment-message',
  }];
  assert.deepEqual(await adapter.delegationFeedback(references), [{
    delegationId: 'payment-delegation',
    state: 'running',
  }]);
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
      queryMessageExecutions: noMessageExecutions,
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
