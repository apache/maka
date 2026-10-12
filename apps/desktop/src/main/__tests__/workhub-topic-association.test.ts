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
import { workHubTasksSchema } from '../../shared/workhub-tool-schema.js';
import { createWorkHubRuntime } from '../workhub-runtime.js';
import { workHubLinkedWork } from '../../renderer/features/workhub/testing.js';
import type { StoredMessage } from '@maka/core/session';

test('a direct CS336 answer has a durable work association without starting execution', async () => {
  const input = workHubTasksSchema.parse({ operation: 'associate', targetSessionId: 'cs336' });
  const writes: unknown[] = [];
  const runtime = createWorkHubRuntime({
    isCurrent: () => true,
    client: () => ({
      listWorkHubCoordinationCandidates: async () => ({ candidateSetId: 'set', candidates: [{ sessionId: 'cs336', sessionName: 'CS336 学习' }] }),
      actWorkHubCoordinationFromTurn: async (value: unknown) => { writes.push(value); throw new Error('must not execute'); },
    } as never),
    createContext: async () => { throw new Error('must not create'); },
    changed: () => { throw new Error('must not change target'); },
  });
  assert.deepEqual(await runtime.actTasks({ hostId: 'host', targetEpoch: 'epoch' }, 'unrelated-turn', 'none-call', workHubTasksSchema.parse({ operation: 'associate', targetSessionId: null, reason: 'unrelated' })), { operation: 'associate', targetSessionId: null, reason: 'unrelated' });
  await assert.rejects(runtime.actTasks({ hostId: 'host', targetEpoch: 'epoch' }, 'unrelated-turn', 'bad-none', workHubTasksSchema.parse({ operation: 'associate', targetSessionId: null })), /requires a reason/);
  const result = await runtime.actTasks({ hostId: 'host', targetEpoch: 'epoch' }, 'turn', 'associate-call', input);
  const messages: StoredMessage[] = [
    { type: 'user', id: 'user', turnId: 'turn', ts: 1, text: '[微信] 336 第一课都有什么内容?' },
    { type: 'tool_call', id: 'associate-call', turnId: 'turn', ts: 2, toolName: 'mcp__desktop_workhub__tasks', args: { request: input } },
    { type: 'tool_result', id: 'association', turnId: 'turn', ts: 3, toolUseId: 'associate-call', isError: false, content: { kind: 'json', value: { structuredContent: result } } },
    { type: 'assistant', id: 'answer', turnId: 'turn', ts: 4, modelId: 'test', text: '第一课从语言模型的基本组成讲起。' },
  ];
  const expected = [{ id: 'association', coordinationTurnId: 'turn', targetSessionId: JSON.stringify(['host', 'cs336']), targetSessionName: 'CS336 学习', workspaceName: undefined }];
  assert.deepEqual(workHubLinkedWork(messages, [], 'Work'), expected);
  assert.deepEqual(workHubLinkedWork(JSON.parse(JSON.stringify(messages)), [], 'Work'), expected);
  assert.deepEqual(writes, []);
  const call = messages[1]!;
  const receipt = messages[2]!;
  assert.equal(receipt.type, 'tool_result');
  if (receipt.type !== 'tool_result' || call.type !== 'tool_call') throw new Error('bad fixture');
  for (const invalid of [
    [call, { ...receipt, isError: true }],
    [{ ...call, toolName: 'OtherTool' }, receipt],
    [call, { ...receipt, turnId: 'other-turn' }],
    [{ ...call, args: { request: { operation: 'associate', targetSessionId: 'sql' } } }, receipt],
    [receipt],
  ] as StoredMessage[][]) assert.deepEqual(workHubLinkedWork(invalid, [], 'Work'), []);
  await assert.rejects(runtime.actTasks({ hostId: 'host', targetEpoch: 'epoch' }, 'turn', 'bad-call', workHubTasksSchema.parse({ operation: 'associate', targetSessionId: 'unrelated' })), /discovery/);
});

async function topicReceipt(turnId: string, id: string, targetSessionId: string | null, reason = 'unrelated'): Promise<[StoredMessage, StoredMessage]> {
  const request = workHubTasksSchema.parse({ operation: 'associate', targetSessionId, ...(targetSessionId === null ? { reason } : {}) });
  const runtime = createWorkHubRuntime({
    isCurrent: () => true,
    client: () => ({
      listWorkHubCoordinationCandidates: async () => ({ candidateSetId: 'set', candidates: ['sql', 'cs336'].map((sessionId) => ({ sessionId, sessionName: sessionId })) }),
      actWorkHubCoordinationFromTurn: async () => { throw new Error('association must not execute work'); },
    } as never),
    createContext: async () => { throw new Error('association must not create work'); },
    changed: () => { throw new Error('association must not change target'); },
  });
  const result = await runtime.actTasks({ hostId: 'host', targetEpoch: 'epoch' }, turnId, id, request);
  return [
    { type: 'tool_call', id, turnId, ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: { request } },
    { type: 'tool_result', id: `${id}-receipt`, turnId, ts: 2, toolUseId: id, isError: false, content: { kind: 'json', value: { structuredContent: result } } },
  ];
}

for (const reason of ['unrelated', 'overview', 'ambiguous']) {
  test(`Desktop retracts a same-turn topic after a successful ${reason} decision`, async () => {
    const initial = await topicReceipt('turn', 'initial', 'sql');
    const cleared = await topicReceipt('turn', 'clear', null, reason);
    const other = await topicReceipt('other-turn', 'other', 'cs336');
    assert.equal(workHubLinkedWork(initial, [], 'Work').length, 1);
    const messages = [...initial, ...other, ...cleared];
    const expected = workHubLinkedWork(other, [], 'Work');
    assert.deepEqual(workHubLinkedWork(messages, [], 'Work'), expected);
    assert.deepEqual(workHubLinkedWork(JSON.parse(JSON.stringify(messages)), [], 'Work'), expected);
  });
}

test('Desktop uses the latest successful topic when switching or reassociating', async () => {
  const initial = await topicReceipt('turn', 'initial', 'sql');
  const switched = await topicReceipt('turn', 'switch', 'cs336');
  const cleared = await topicReceipt('turn', 'clear', null);
  const restored = await topicReceipt('turn', 'restore', 'sql');
  assert.deepEqual(workHubLinkedWork([...initial, ...switched], [], 'Work'), workHubLinkedWork(switched, [], 'Work'));
  assert.deepEqual(workHubLinkedWork([...initial, ...cleared, ...restored], [], 'Work'), workHubLinkedWork(restored, [], 'Work'));
});

test('Desktop ignores failed, mismatched, and orphaned topic clearing receipts', async () => {
  const initial = await topicReceipt('turn', 'initial', 'sql');
  const [call, result] = await topicReceipt('turn', 'clear', null);
  assert.ok(result.type === 'tool_result' && call.type === 'tool_call');
  if (result.type !== 'tool_result' || call.type !== 'tool_call') return;
  const expected = workHubLinkedWork(initial, [], 'Work');
  for (const invalid of [
    [call, { ...result, isError: true }],
    [call, { ...result, turnId: 'other-turn' }],
    [{ ...call, turnId: 'other-turn' }, result],
    [{ ...call, args: { request: { operation: 'associate', targetSessionId: 'sql' } } }, result],
    [call, { ...result, toolUseId: 'other-call' }],
    [result],
  ] as StoredMessage[][]) assert.deepEqual(workHubLinkedWork([...initial, ...invalid], [], 'Work'), expected);
});

test('Desktop topic clearing preserves genuine delegation and result links', async () => {
  const initial = await topicReceipt('turn', 'initial', 'sql');
  const cleared = await topicReceipt('turn', 'clear', null);
  const facts: StoredMessage[] = [
    { type: 'tool_call', id: 'delegate', turnId: 'turn', ts: 3, toolName: 'mcp__desktop_workhub__tasks', args: { request: workHubTasksSchema.parse({ operation: 'delegate_existing', candidateRef: 'sql-candidate', text: 'Continue SQL work' }) } },
    { type: 'tool_result', id: 'delegated', turnId: 'turn', ts: 4, toolUseId: 'delegate', isError: false, content: { kind: 'json', value: { structuredContent: { disposition: 'delegate_existing', targetSessionKey: JSON.stringify(['host', 'sql']) } } } },
    { type: 'user', id: 'feedback', turnId: 'turn', ts: 5, text: 'result', origin: { kind: 'workhub_result', actionId: 'delegate', eventId: 'event', delegationId: 'delegation', targetSessionId: 'sql', targetTurnId: 'target-turn' } },
  ];
  const key = JSON.stringify(['host', 'workhub']);
  const expected = workHubLinkedWork(facts, [], 'Work', key);
  assert.deepEqual(expected.map(({ id }) => id), ['delegated', 'feedback']);
  assert.deepEqual(workHubLinkedWork([...initial, ...facts, ...cleared], [], 'Work', key), expected);
});
