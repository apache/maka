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
import test, { type TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
async function fixture(t: TestContext, workName: string | ((id: string) => string) = 'SQL 入门') {
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
    getSession: async (id) => ({ name: typeof workName === 'function' ? workName(id) : workName } as never),
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
  const projectFrame = async (frame: SubscriptionFrame) => {
    const nextRead = Math.max(1, events.nextCount) + 1;
    events.push(frame);
    // The bridge reads its next frame only after reconciliation has finished.
    await t.waitFor(() => assert.ok(events.nextCount >= nextRead));
  };
  return {
    sends, starts, answers, errors, get bridge() { return bridge; },
    setBusy(value: boolean) { busy = value; },
    setMode(value: typeof mode) { mode = value; },
    async project(value: InteractionPendingSnapshot[]) { pending = value; await projectFrame({ kind: 'subscription.session_projection', snapshot: snapshot() } as SubscriptionFrame); },
    async transcript(value: StoredMessage[], done = true) { rows = value; completed = done; await projectFrame({ kind: 'subscription.transcript_advanced', throughSequence: rows.length - 1 } as SubscriptionFrame); },
    async recoverLegacy(value: StoredMessage[]) {
      await bridge.close();
      rows = value;
      completed = true;
      const state = JSON.parse(await readFile(deps.statePath, 'utf8'));
      state.version = 1;
      state.through = rows.length - 1;
      state.actions = {};
      await writeFile(deps.statePath, JSON.stringify(state));
      events = new AsyncFrameQueue();
      bridge = createWorkHubRemoteBridge(deps);
      await projectFrame({ kind: 'subscription.session_projection', snapshot: snapshot() } as SubscriptionFrame);
    },
    async restart() { await bridge.close(); events = new AsyncFrameQueue(); bridge = createWorkHubRemoteBridge(deps); await projectFrame({ kind: 'subscription.session_projection', snapshot: snapshot() } as SubscriptionFrame); },
    async close() { await bridge.close(); await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); },
  };
}
function question(turnId: string): InteractionPendingSnapshot {
  return { schemaVersion: 1, revision: 1, status: 'pending', outcome: null, sessionId, turnId, runId: 'run', interactionId: 'question-1', request: { kind: 'question', toolUseId: 'ask', questions: ['项目', '范围', '测试'].map((question) => ({ question, options: ['甲', '乙', '丙'].map((label) => ({ label })) })) } };
}
test('all chats use one WorkHub; questions route to their source and survive restart', async (t) => {
  const f = await fixture(t);
  try {
    assert.equal(await f.bridge.handle(message('one', '修改 Maka')), true);
    const turnId = f.starts[0]!.turnId;
    await f.project([question(turnId)]);
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0]!.chat, 'one');
    assert.ok(f.sends[0]!.text.includes('3. 测试'));
    assert.ok(f.sends[0]!.text.startsWith('待回答 #'));
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
test('delegated asynchronous result returns to original chat after restart, never the last chat', async (t) => {
  const f = await fixture(t);
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
    assert.deepEqual(f.sends, [{ chat: 'one', text: '[SQL 入门]\n功能完成' }]);
    await f.restart();
    assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});
test('task setting leaves the existing Bot Session route in charge', async (t) => {
  const f = await fixture(t);
  try { f.setMode('task'); assert.equal(await f.bridge.handle(message('one', 'hello')), false); assert.equal(f.starts.length, 0); }
  finally { await f.close(); }
});

test('busy WorkHub queues messages durably and dispatches after restart without changing their source', async (t) => {
  const f = await fixture(t);
  try {
    f.setBusy(true);
    await f.bridge.handle(message('one', '先做这个'));
    await f.bridge.handle(message('two', '再做那个'));
    assert.equal(f.starts.length, 0);
    assert.equal(f.sends.length, 2);
    f.setBusy(false);
    await f.restart();
    assert.equal(f.starts.length, 2);
    assert.ok(f.starts[0]!.text.includes('先做这个'));
    assert.ok(f.starts[1]!.text.includes('再做那个'));
    await f.bridge.handle(message('one', '先做这个'));
    assert.equal(f.starts.length, 2, 'same incoming source message is not admitted twice');
  } finally { await f.close(); }
});
test('nxt resumes the recent-work picker in its source chat without queuing a new turn', async (t) => {
  const f = await fixture(t);
  try {
    await f.bridge.handle(message('one', 'wn'));
    const pending: InteractionPendingSnapshot = {
      ...question(f.starts[0]!.turnId),
      request: { kind: 'question', toolUseId: 'ask', questions: [{ question: '最近的工作:', options: [{ label: 'SQL 入门' }, { label: '取消' }] }] },
    };
    await f.project([pending]);
    await f.bridge.handle(message('one', 'nxt'));
    assert.deepEqual(f.answers, [{ sessionId, interactionId: 'question-1', answer: { kind: 'question', answers: ['nxt'] } }]);
    assert.equal(f.starts.length, 1);
  } finally { await f.close(); }
});

test('runtime transcript tool calls route delegated feedback without legacy assignment rows', async (t) => {
  const f = await fixture(t);
  try {
    await f.bridge.handle(message('one', '检查 SQL'));
    const firstTurn = f.starts[0]!.turnId;
    await f.bridge.handle(message('two', '另一项工作'));
    const call: StoredMessage = { type: 'tool_call', id: 'action-live', turnId: firstTurn, ts: 1,
      toolName: 'mcp__desktop_workhub__tasks', args: { request: { operation: 'delegate_existing' } } };
    await f.transcript([call]);
    await f.restart();
    await f.transcript([call,
      { type: 'user', id: 'feedback-live', turnId: 'feedback-live', ts: 2, text: 'result', origin: { kind: 'workhub_result', actionId: 'action-live', eventId: 'event', delegationId: 'd', targetSessionId: 'target', targetTurnId: 'target-turn' } },
      { type: 'assistant', id: 'reply-live', turnId: 'feedback-live', ts: 3, text: 'SQL 检查反馈', modelId: 'test' },
    ]);
    assert.deepEqual(f.sends, [{ chat: 'one', text: '[SQL 入门]\nSQL 检查反馈' }]);
    await f.restart();
    assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});

test('legacy cursor recovery delivers missed feedback without repeating the original receipt', async (t) => {
  const f = await fixture(t);
  try {
    await f.bridge.handle(message('one', '检查 SQL'));
    const turnId = f.starts[0]!.turnId;
    const receipt: StoredMessage = { type: 'assistant', id: 'receipt', turnId, ts: 1, text: '已交给 SQL 工作检查', modelId: 'test' };
    await f.transcript([receipt]);
    assert.equal(f.sends.length, 1);
    await f.recoverLegacy([receipt,
      { type: 'tool_call', id: 'legacy-action', turnId, ts: 2, toolName: 'mcp__desktop_workhub__tasks', args: {} },
      { type: 'user', id: 'feedback', turnId: 'feedback', ts: 3, text: 'result', origin: { kind: 'workhub_result', actionId: 'legacy-action', eventId: 'event', delegationId: 'd', targetSessionId: 'target', targetTurnId: 'target-turn' } },
      { type: 'assistant', id: 'reply', turnId: 'feedback', ts: 4, text: 'SQL 检查反馈', modelId: 'test' },
    ]);
    assert.deepEqual(f.sends, [{ chat: 'one', text: '已交给 SQL 工作检查' }, { chat: 'one', text: '[SQL 入门]\nSQL 检查反馈' }]);
    await f.restart();
    assert.equal(f.sends.length, 2);
  } finally { await f.close(); }
});

test('delayed feedback keeps its own work heading after a newer request in the same chat', async (t) => {
  const f = await fixture(t);
  try {
    await f.bridge.handle(message('one', '检查 SQL'));
    const turnId = f.starts[0]!.turnId;
    const call: StoredMessage = { type: 'tool_call', id: 'sql-action', turnId, ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: {} };
    await f.transcript([call]);
    await f.bridge.handle(message('one', '先聊 CS336'));
    await f.restart();
    await f.transcript([call,
      { type: 'user', id: 'feedback', turnId: 'feedback', ts: 2, text: 'result', origin: { kind: 'workhub_result', actionId: 'sql-action', eventId: 'event', delegationId: 'd', targetSessionId: 'target', targetTurnId: 'target-turn' } },
      { type: 'assistant', id: 'reply', turnId: 'feedback', ts: 3, text: 'SELECT 后面还缺列名。', modelId: 'test' },
    ]);
    assert.deepEqual(f.sends, [{ chat: 'one', text: '[SQL 入门]\nSELECT 后面还缺列名。' }]);
  } finally { await f.close(); }
});

test('direct-answer topic receipts survive paging and label a delayed answer without delegation', async (t) => {
  for (const newerRequest of [false, true]) {
    const f = await fixture(t);
    try {
      await f.bridge.handle(message('one', 'SQL 第一题是什么？'));
      const turnId = f.starts[0]!.turnId;
      const call: StoredMessage = { type: 'tool_call', id: 'associate', turnId, ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: { request: { operation: 'associate', targetSessionId: 'sql' } } };
      await f.transcript([call], false);
      if (newerRequest) await f.bridge.handle(message('one', '再看看 CS336'));
      await f.restart();
      await f.transcript([call,
        { type: 'tool_result', id: 'topic', turnId, ts: 2, toolUseId: call.id, isError: false, content: { kind: 'json', value: { structuredContent: { operation: 'associate', targetSessionId: 'sql', targetSessionKey: JSON.stringify(['host', 'sql']), targetSessionName: 'SQL 入门' } } } },
        { type: 'assistant', id: 'answer', turnId, ts: 3, text: '查询评分不低于 9 的电影。', modelId: 'test' },
      ]);
      assert.deepEqual(f.sends, [{ chat: 'one', text: '[SQL 入门]\n查询评分不低于 9 的电影。' }]);
      assert.equal(f.starts.length, newerRequest ? 2 : 1);
      await f.restart();
      assert.equal(f.sends.length, 1, 'already delivered answers are not resent');
    } finally { await f.close(); }
  }
});

test('the latest WeChat follow-up carries its associated work heading without a newer request', async (t) => {
  const f = await fixture(t, 'CS336');
  try {
    await f.bridge.handle({ ...message('wechat-owner', '刚才到第几讲内容了?'), platform: 'wechat' });
    const turnId = f.starts[0]!.turnId;
    const call: StoredMessage = { type: 'tool_call', id: 'associate-current', turnId, ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: { request: { operation: 'associate', targetSessionId: 'cs336' } } };
    await f.transcript([call], false);
    await f.restart();
    await f.transcript([call,
      { type: 'tool_result', id: 'topic-current', turnId, ts: 2, toolUseId: call.id, isError: false, content: { kind: 'json', value: { structuredContent: { operation: 'associate', targetSessionId: 'cs336', targetSessionKey: JSON.stringify(['host', 'cs336']), targetSessionName: 'CS336' } } } },
      { type: 'assistant', id: 'answer-current', turnId, ts: 3, text: '刚到第 2 讲。', modelId: 'test' },
    ]);
    assert.deepEqual(f.sends, [{ chat: 'wechat-owner', text: '[CS336]\n刚到第 2 讲。' }]);
    assert.equal(f.starts.length, 1, 'association does not dispatch work');
    await f.restart();
    assert.equal(f.sends.length, 1, 'already delivered answers are not resent');
  } finally { await f.close(); }
});

function association(turnId: string, id: string, targetSessionId: string | null, reason = 'unrelated'): [StoredMessage, StoredMessage] {
  const request = targetSessionId === null ? { operation: 'associate', targetSessionId, reason } : { operation: 'associate', targetSessionId };
  const receipt = targetSessionId === null ? request : { ...request, targetSessionKey: JSON.stringify(['host', targetSessionId]), targetSessionName: 'SQL 入门' };
  return [
    { type: 'tool_call', id, turnId, ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: { request } },
    { type: 'tool_result', id: `${id}-result`, turnId, ts: 2, toolUseId: id, isError: false, content: { kind: 'json', value: { structuredContent: receipt } } },
  ];
}

for (const reason of ['unrelated', 'overview', 'ambiguous']) {
  test(`a same-turn ${reason} correction clears the remote heading across restart`, async (t) => {
    const f = await fixture(t);
    try {
      await f.bridge.handle(message('one', '这不是 SQL 的问题'));
      const turnId = f.starts[0]!.turnId;
      const initial = association(turnId, 'initial', 'sql');
      const correction = association(turnId, 'correction', null, reason);
      if (reason === 'overview' && correction[1].type === 'tool_result') correction[1].content = { kind: 'text', text: JSON.stringify({ operation: 'associate', targetSessionId: null, reason }) };
      await f.transcript([...initial, correction[0]], false);
      await f.restart();
      await f.transcript([...initial, ...correction], false);
      await f.restart();
      await f.transcript([...initial, ...correction,
        { type: 'assistant', id: 'answer', turnId, ts: 3, text: '这是通用回答。', modelId: 'test' },
      ]);
      assert.deepEqual(f.sends, [{ chat: 'one', text: '这是通用回答。' }]);
      assert.equal(f.starts.length, 1, 'association corrections do not dispatch work');
      await f.restart();
      assert.equal(f.sends.length, 1, 'a cleared heading does not break delivery deduplication');
    } finally { await f.close(); }
  });
}

for (const invalid of ['error', 'wrapped-error', 'target', 'turn', 'call', 'reason', 'missing-reason']) {
  test(`a ${invalid} clearing receipt cannot erase the current remote heading`, async (t) => {
    const f = await fixture(t);
    try {
      await f.bridge.handle(message('one', 'SQL 问题'));
      const turnId = f.starts[0]!.turnId;
      const initial = association(turnId, 'initial', 'sql');
      const correction = association(turnId, 'correction', null);
      const result = correction[1];
      assert.equal(result.type, 'tool_result');
      if (result.type !== 'tool_result') return;
      if (invalid === 'error') result.isError = true;
      if (invalid === 'turn') correction[0].turnId = 'another-turn';
      if (invalid === 'call') result.toolUseId = 'another-call';
      if (invalid === 'target') correction[0] = association(turnId, 'correction', 'cs336')[0];
      if (invalid === 'wrapped-error') result.content = { kind: 'json', value: { isError: true, structuredContent: { operation: 'associate', targetSessionId: null, reason: 'unrelated' } } };
      if (invalid === 'reason' || invalid === 'missing-reason') result.content = { kind: 'json', value: { operation: 'associate', targetSessionId: null, ...(invalid === 'reason' ? { reason: 'invalid' } : {}) } };
      await f.transcript([...initial, ...correction,
        { type: 'assistant', id: 'answer', turnId, ts: 3, text: 'SQL 回答。', modelId: 'test' },
      ]);
      assert.deepEqual(f.sends, [{ chat: 'one', text: '[SQL 入门]\nSQL 回答。' }]);
    } finally { await f.close(); }
  });
}

for (const chat of ['one', 'two']) {
  test(`a clearing receipt cannot cross turns in chat ${chat}`, async (t) => {
    const f = await fixture(t);
    try {
      await f.bridge.handle(message('one', 'SQL 问题'));
      await f.bridge.handle(message(chat, '另一个 SQL 问题'));
      const first = f.starts[0]!.turnId;
      const second = f.starts[1]!.turnId;
      const correction = association(first, 'correction', null);
      correction[1].turnId = second;
      await f.transcript([...association(first, 'first', 'sql'), ...association(second, 'second', 'sql'), ...correction,
        { type: 'assistant', id: 'answer-first', turnId: first, ts: 3, text: '第一条回答。', modelId: 'test' },
        { type: 'assistant', id: 'answer-second', turnId: second, ts: 4, text: '第二条回答。', modelId: 'test' },
      ]);
      assert.deepEqual(f.sends, [
        { chat: 'one', text: '[SQL 入门]\n第一条回答。' },
        { chat, text: '[SQL 入门]\n第二条回答。' },
      ]);
    } finally { await f.close(); }
  });
}

test('a same-turn topic switch uses the corrected work heading', async (t) => {
  const f = await fixture(t, (id) => id === 'cs336' ? 'CS336' : 'SQL 入门');
  try {
    await f.bridge.handle(message('one', '其实是 CS336'));
    const turnId = f.starts[0]!.turnId;
    await f.transcript([...association(turnId, 'initial', 'sql'), ...association(turnId, 'switch', 'cs336'),
      { type: 'assistant', id: 'answer', turnId, ts: 3, text: '课程回答。', modelId: 'test' },
    ]);
    assert.deepEqual(f.sends, [{ chat: 'one', text: '[CS336]\n课程回答。' }]);
  } finally { await f.close(); }
});
