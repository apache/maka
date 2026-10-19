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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOT_PROVIDERS, createDefaultBotChannel, type BotProvider, type BotChannelSettings } from '@maka/core/bot-chat-settings';
import type { BotIncomingMessage } from '@maka/runtime/bots';
import { createAssistantImBridge } from '../assistant-im-bridge.js';
import { createAssistantWechatBridge } from '../assistant-wechat-bridge.js';
import { createBotIncomingMainService } from '../bot-incoming-main.js';
import type { WebMessage } from '../../shared/assistant-web.js';

const incoming = (id = 'source-1'): BotIncomingMessage => ({
  platform: 'wechat',
  chatId: 'owner',
  userId: 'owner',
  userName: 'Owner',
  text: '继续查一下',
  sourceMessageId: id,
  receivedAt: 1,
  isGroup: false,
});
async function fixture(platform: BotProvider = 'wechat') {
  const dir = await mkdtemp(join(tmpdir(), 'maka-wechat-'));
  let channel: BotChannelSettings = {
    ...createDefaultBotChannel(platform),
    enabled: true,
    messageHandling: 'assistant' as const,
    token: 'synthetic',
    allowedUserIds: ['owner'],
  };
  let enabled = true;
  let working = false;
  const typing: boolean[] = [];
  let active = true;
  let calls = 0;
  let fail = false;
  const messages: WebMessage[] = [
    { id: 'old', sequence: 1, role: 'assistant', text: '不应补发的旧消息', at: 1 },
  ];
  const sent: { chat: string; text: string; options?: { summary?: string; clientMessageId?: string } }[] = [];
  const inputs: { id: string; text: string }[] = [];
  const errors: unknown[] = [];
  let hold: Promise<void> | undefined;
  let typingHold: Promise<void> | undefined;
  const deps = {
    platform,
    backend: {
      async state() {
        calls++;
        if (!enabled) throw Error('disabled');
        return {
          conversationId: 'assistant-owner',
          working,
          revision: messages.at(-1)!.sequence,
          avatar: { emoji: '🦊', background: '#fff' },
        };
      },
      async history(q: URLSearchParams) {
        return {
          conversationId: 'assistant-owner',
          messages: messages.filter((m) => m.sequence > Number(q.get('after'))),
          through: messages.at(-1)!.sequence,
          next: null,
        };
      },
      async send(input: { id: string; text: string }) {
        inputs.push(input);
      },
      async close() {},
    },
    async readChannel() {
      return channel;
    },
    registry: {
      async sendTypingIndicator() { typing.push(true); await typingHold; return true; },
      async cancelTypingIndicator() { typing.push(false); return true; },
      async getMessageReadStatus() { return { state: 'read' as const }; },
      async sendMessage(_platform: string, chat: string, text: string, options?: { summary?: string; clientMessageId?: string }) {
        sent.push({ chat, text, options });
        await hold;
        return fail ? null : 'accepted';
      },
    },
    statePath: join(dir, 'receipts.json'),
    isActive: () => active,
    onError: (e: unknown) => {
      errors.push(e);
    },
    retryMs: 0,
    pollMs: 3600000,
  };
  let bridge = (platform === 'wechat' ? createAssistantWechatBridge(deps) : createAssistantImBridge(deps));
  return {
    get bridge() {
      return bridge;
    },
    sent,
    typing,
    setWorking(value: boolean) { working = value; },
    setTypingHold(value: Promise<void> | undefined) { typingHold = value; },
    inputs,
    messages,
    errors,
    setFail(v: boolean) {
      fail = v;
    },
    setHold(v: Promise<void> | undefined) {
      hold = v;
    },
    setEnabled(v: boolean) {
      enabled = v;
    },
    setActive(v: boolean) {
      active = v;
    },
    setChannel(v: Partial<typeof channel>) {
      channel = { ...channel, ...v };
    },
    get calls() {
      return calls;
    },
    async receipt() {
      return JSON.parse(await readFile(deps.statePath, 'utf8'));
    },
    async restart() {
      await bridge.close();
      bridge = (platform === 'wechat' ? createAssistantWechatBridge(deps) : createAssistantImBridge(deps));
    },
    async close() {
      await bridge.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('confirmation freezes history; all new SendUser rows mirror once across restart', async () => {
  const f = await fixture();
  try {
    await f.bridge.tick();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.text, /已连接/);
    f.messages.push(
      {
        id: 'discovery',
        sequence: 2,
        role: 'assistant',
        summary: '摘要',
        text: '主动发现完整正文',
        at: 2,
      },
      { id: 'task', sequence: 3, role: 'assistant', text: '耗时任务结果', at: 3 },
    );
    await Promise.all([f.bridge.tick(), f.bridge.tick()]);
    assert.deepEqual(
      f.sent.slice(1).map((x) => x.text),
      ['主动发现完整正文', '耗时任务结果'],
    );
    await f.restart();
    await f.bridge.tick();
    assert.equal(f.sent.length, 3);
    assert.equal((await f.receipt()).through, 3);
    assert.equal((await f.receipt()).delivery.acceptedMessageId, 'accepted');
  } finally {
    await f.close();
  }
});

test('delivery retries once, records failure, continues to newer messages and never replays exhausted attempts', async () => {
  const f = await fixture();
  try {
    await f.bridge.tick();
    f.setFail(true);
    f.messages.push({ id: 'failed', sequence: 2, role: 'assistant', text: '暂时发不过去', at: 2 });
    await f.bridge.tick();
    assert.equal(f.sent.length, 3);
    const r = await f.receipt();
    assert.equal(r.delivery.attempts, 2);
    assert.equal(r.delivery.done, true);
    assert.ok(r.delivery.error);
    await f.restart();
    await f.bridge.tick();
    assert.equal(f.sent.length, 3);
    f.setFail(false);
    f.messages.push({ id: 'next', sequence: 3, role: 'assistant', text: '下一条', at: 3 });
    await f.bridge.tick();
    assert.equal(f.sent.at(-1)!.text, '下一条');
    assert.equal(f.errors.length, 1);
  } finally {
    await f.close();
  }
});

test('slow outbound never blocks Inbox admission; retries reuse stable source IDs', async () => {
  const f = await fixture();
  let release!: () => void;
  try {
    f.setHold(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const tick = f.bridge.tick();
    // Wait for confirmation to be in flight, rather than timing an arbitrary sleep.
    while (!f.sent.length) await new Promise((r) => setImmediate(r));
    await f.bridge.handle(incoming());
    await f.bridge.handle(incoming());
    assert.equal(f.inputs.length, 2);
    assert.equal(f.inputs[0]!.id, f.inputs[1]!.id);
    assert.equal(f.inputs[0]!.text, '继续查一下');
    release();
    await tick;
    await assert.rejects(
      f.bridge.handle({ ...incoming(), userId: 'stranger', chatId: 'stranger' }),
    );
    await assert.rejects(f.bridge.handle({ ...incoming(), isGroup: true }));
  } finally {
    release?.();
    await f.close();
  }
});

test('disabled/unpaired/inactive transport does not observe history; assistant disablement stops sends', async () => {
  const f = await fixture();
  try {
    f.setChannel({ enabled: false });
    await f.bridge.tick();
    assert.equal(f.calls, 0);
    f.setChannel({ enabled: true, allowedUserIds: [] });
    await f.bridge.tick();
    assert.equal(f.calls, 0);
    f.setChannel({ allowedUserIds: ['owner'] });
    f.setActive(false);
    await f.bridge.tick();
    assert.equal(f.calls, 0);
    f.setActive(true);
    f.setEnabled(false);
    await assert.rejects(f.bridge.tick());
    assert.equal(f.sent.length, 0);
    f.setEnabled(true);
    await f.bridge.tick();
    f.setChannel({ allowedUserIds: ['another-owner'] });
    await f.bridge.tick();
    assert.equal(f.sent.at(-1)!.chat, 'another-owner');
    assert.match(f.sent.at(-1)!.text, /已连接/);
  } finally {
    await f.close();
  }
});

test('WeChat can select assistant, while explicit task and WorkHub modes keep their routes', async () => {
  let handled = 0,
    workhub = 0,
    created = 0;
  let mode: 'assistant' | 'task' | 'workhub' = 'assistant';
  const service = createBotIncomingMainService({
    readMode: async (platform) => platform === 'wechat' ? mode : 'workhub',
    sessions: {
      async createSession() {
        created++;
        return 'unused';
      },
      async prepareSession() {
        return 'ready';
      },
      async runTurn() {
        return { kind: 'completed', text: '' };
      },
    },
    workHub: {
      async handle() {
        workhub++;
        return mode !== 'task';
      },
      async close() {},
    },
    assistants: { wechat: {
      async handle() {
        handled++;
      },
      async close() {},
    } },
    botRegistry: {
      async sendMessage() {
        return 'ok';
      },
    } as any,
  });
  try {
    await service.handleBotIncomingMessage({ ...incoming(), text: '重置' });
    assert.equal(handled, 1);
    assert.equal(workhub, 0);
    assert.equal(created, 0);
    await service.handleBotIncomingMessage({ ...incoming('tg'), platform: 'telegram' });
    assert.equal(workhub, 1);
    mode = 'workhub';
    await service.handleBotIncomingMessage(incoming('workhub'));
    assert.equal(workhub, 2);
    assert.equal(handled, 1);
    mode = 'task';
    await service.handleBotIncomingMessage(incoming('task'));
    assert.equal(created, 1);
    assert.equal(handled, 1);
  } finally {
    await service.close();
  }
});

 test('changing WeChat mode stops assistant observation and sends; returning starts a fresh boundary', async () => {
  const f = await fixture();
  try {
    await f.bridge.tick();
    const calls = f.calls;
    f.setChannel({ messageHandling: 'task' });
    f.messages.push({ id: 'other-mode', sequence: 2, role: 'assistant', text: '不要补发', at: 2 });
    await f.bridge.tick();
    assert.equal(f.calls, calls);
    assert.equal(f.sent.length, 1);
    await assert.rejects(f.bridge.handle(incoming()));
    f.setChannel({ messageHandling: 'assistant' });
    await f.bridge.tick();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1]!.text, /已连接/);
    assert.equal((await f.receipt()).through, 2);
  } finally { await f.close(); }
});

 test('assistant typing follows Bot work, clears on sleep, failure, mode changes and shutdown', async () => {
  const f = await fixture();
  try {
    await f.bridge.tickTyping(); assert.deepEqual(f.typing, []);
    f.setWorking(true); await f.bridge.tickTyping(); assert.deepEqual(f.typing, [true]);
    await f.bridge.tickTyping(); assert.deepEqual(f.typing, [true]); // rate limited
    f.setWorking(false); await f.bridge.tickTyping(); assert.deepEqual(f.typing, [true, false]);
    f.setWorking(true); await f.bridge.tickTyping();
    f.setChannel({ messageHandling: 'task' }); await f.bridge.tickTyping(); assert.equal(f.typing.at(-1), false);
    f.setChannel({ messageHandling: 'assistant' }); await f.bridge.tickTyping();
    f.setEnabled(false); await f.bridge.tickTyping(); assert.equal(f.typing.at(-1), false);
    f.setEnabled(true); await f.bridge.tickTyping(); await f.bridge.close(); assert.equal(f.typing.at(-1), false);
  } finally { await f.close(); }
});

 test('slow typing does not block messages or replies, and close clears the late indicator', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    f.setWorking(true);
    f.setTypingHold(new Promise<void>(resolve => { release = resolve; }));
    const typing = f.bridge.tickTyping();
    while (!f.typing.length) await new Promise(resolve => setImmediate(resolve));
    await f.bridge.handle(incoming()); assert.equal(f.inputs.length, 1);
    await f.bridge.tick(); assert.equal(f.sent.length, 1);
    const closing = f.bridge.close(); release(); await typing; await closing;
    assert.deepEqual(f.typing, [true, false]);
  } finally { release?.(); await f.close(); }
});

test('Feishu shares assistant history, preserves summary and stable retry identity; DM chat differs from open_id', async () => {
  const f = await fixture('feishu');
  try {
    await f.bridge.tick();
    const msg = { ...incoming(), platform: 'feishu' as const, chatId: 'oc_private' };
    await f.bridge.handle(msg);
    assert.match(f.inputs[0]!.id, /^feishu-/);
    await assert.rejects(f.bridge.handle({ ...msg, isGroup: true }));
    await assert.rejects(f.bridge.handle({ ...msg, userId: 'stranger' }));
    f.messages.push({ id: 'discovery', sequence: 2, role: 'assistant', text: '完整发现', summary: '摘要', at: 2 });
    f.setFail(true);
    await f.bridge.tick();
    const attempts = f.sent.filter((s) => s.text === '完整发现');
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.options?.summary, '摘要');
    assert.deepEqual(attempts[0], attempts[1]);
    assert.ok(attempts[0]!.options?.clientMessageId);
    await f.restart(); await f.bridge.tick();
    assert.equal(f.sent.filter((s) => s.text === '完整发现').length, 2);
    assert.ok(f.sent.every((s) => s.text !== '不应补发的旧消息'));
    f.setFail(false);
    f.messages.push({ id: 'matter', sequence: 3, role: 'assistant', text: '任务结果', at: 3 });
    await f.bridge.tick(); await f.bridge.tickReadStatus();
    const receipt = await f.receipt();
    assert.equal(receipt.delivery.readState, 'read');
    assert.equal(receipt.delivery.acceptedMessageId, 'accepted');
  } finally { await f.close(); }
});
for (const platform of BOT_PROVIDERS) {
test(`${platform} routes assistant, WorkHub and separate tasks without spawning duplicate Sessions`, async () => {
  let handled = 0,
    workhub = 0,
    created = 0;
  let mode: 'assistant' | 'task' | 'workhub' = 'assistant';
  const service = createBotIncomingMainService({
    readMode: async () => mode,
    sessions: {
      async createSession() {
        created++;
        return 'unused';
      },
      async prepareSession() {
        return 'ready';
      },
      async runTurn() {
        return { kind: 'completed', text: '' };
      },
    },
    workHub: {
      async handle() {
        workhub++;
        return mode !== 'task';
      },
      async close() {},
    },
    assistants: { [platform]: {
      async handle() {
        handled++;
      },
      async close() {},
    } },
    botRegistry: {
      async sendMessage() {
        return 'ok';
      },
    } as any,
  });
  try {
    await service.handleBotIncomingMessage({ ...incoming(), platform, text: '重置' });
    assert.equal(handled, 1);
    assert.equal(workhub, 0);
    assert.equal(created, 0);
    mode = 'workhub';
    await service.handleBotIncomingMessage({ ...incoming('workhub'), platform });
    assert.equal(workhub, 1);
    assert.equal(handled, 1);
    mode = 'task';
    await service.handleBotIncomingMessage({ ...incoming('task'), platform });
    assert.equal(created, 1);
    assert.equal(handled, 1);
  } finally {
    await service.close();
  }
});

}

for (const platform of BOT_PROVIDERS) {
  test(`${platform}: assistant private routing, reply destination and receipt survive restart`, async () => {
    const f = await fixture(platform);
    const chatId = platform === 'wechat' ? 'owner' : `${platform}-private-chat`;
    try {
      await assert.rejects(f.bridge.handle({ ...incoming(), platform, chatId, isGroup: true }));
      await assert.rejects(f.bridge.handle({ ...incoming(), platform, chatId, userId: 'stranger' }));
      assert.equal(f.inputs.length, 0);
      if (platform !== 'wechat' && platform !== 'feishu') {
        await f.bridge.tick();
        assert.equal(f.sent.length, 0, 'must not guess a chat ID from a user ID');
      }
      await f.bridge.handle({ ...incoming(), platform, chatId });
      assert.equal(f.inputs.length, 1);
      f.messages.push({ id: 'reply', sequence: 2, role: 'assistant', text: '新的回复', at: 2 });
      await f.bridge.tick();
      assert.ok(f.sent.some((m) => m.text === '新的回复' && m.chat === chatId));
      assert.ok(f.sent.every((m) => m.chat === chatId));
      const count = f.sent.length;
      await f.restart();
      await f.bridge.tick();
      assert.equal(f.sent.length, count, 'restart must not replay delivered messages');
      f.setChannel({ messageHandling: 'task' });
      f.messages.push({ id: 'hidden', sequence: 3, role: 'assistant', text: '不应转发', at: 3 });
      await f.bridge.tick();
      assert.equal(f.sent.length, count);
    } finally { await f.close(); }
  });
}
