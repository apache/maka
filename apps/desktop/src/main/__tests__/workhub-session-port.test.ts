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
import {
  createDesktopWorkHubSessionPort,
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
    sessions: {
      list: async () => [],
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
  await adapter.stop(created.target);
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
    ['stop', 'created', { source: 'stop_button' }],
    ['unsubscribe'],
  ]);
});

test('desktop adapter derives stable origin evidence from the existing Session log', async () => {
  let reads = 0;
  const adapter = createDesktopWorkHubSessionPort({
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
