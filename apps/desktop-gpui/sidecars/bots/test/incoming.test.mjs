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

// Chat to Session routing (incoming.mjs) against a fake Host: the limits and
// behaviour of Desktop's bot-incoming-main.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBotIncomingService } from '../incoming.mjs';
import { botMessage, fakeRegistry, fakeSessions, maka } from './support.mjs';

async function routing({ sessions = fakeSessions(), clock = { now: 1_000_000 } } = {}) {
  const botRegistry = fakeRegistry();
  let turn = 0;
  const service = createBotIncomingService({
    botRegistry,
    sessions,
    maka: await maka(),
    now: () => clock.now,
    newId: () => `turn-${++turn}`,
  });
  return { service, botRegistry, sessions, clock };
}

test('a redelivered message is answered once', async () => {
  const { service, botRegistry, sessions } = await routing();
  const message = botMessage({ text: 'hello', sourceMessageId: '11' });
  await service.handleBotIncomingMessage(message);
  await service.handleBotIncomingMessage({ ...message });
  assert.equal(sessions.turns.length, 1);
  assert.deepEqual(
    botRegistry.sent.map(({ text }) => text),
    ['echo [Telegram:test_user] hello'],
  );
});

test('one chat keeps its Session and another chat gets its own', async () => {
  const { service, sessions } = await routing();
  await service.handleBotIncomingMessage(botMessage({ text: 'one', sourceMessageId: '1' }));
  await service.handleBotIncomingMessage(botMessage({ text: 'two', sourceMessageId: '2' }));
  await service.handleBotIncomingMessage(
    botMessage({ text: 'three', sourceMessageId: '1', chatId: '8002' }),
  );
  assert.deepEqual(sessions.created, [
    { name: 'Telegram 任务', labels: ['bot', 'telegram'], sessionId: 'session-1' },
    { name: 'Telegram 任务', labels: ['bot', 'telegram'], sessionId: 'session-2' },
  ]);
  assert.deepEqual(
    sessions.turns.map(({ sessionId, text }) => [sessionId, text]),
    [
      ['session-1', '[Telegram:test_user] one'],
      ['session-1', '[Telegram:test_user] two'],
      ['session-2', '[Telegram:test_user] three'],
    ],
  );
  // The reused Session is switched to explore before its Turn.
  assert.deepEqual(sessions.prepared, ['session-1']);
});

// Desktop's BOT_CONVERSATION_RATE_BURST and BOT_CONVERSATION_RATE_REFILL_MS.
const BOT_CONVERSATION_RATE_BURST = 8;
const BOT_CONVERSATION_RATE_REFILL_MS = 5_000;

test('eight messages in a burst pass, the ninth waits for the refill', async () => {
  const { service, botRegistry, sessions, clock } = await routing();
  for (let index = 1; index <= BOT_CONVERSATION_RATE_BURST + 1; index += 1) {
    await service.handleBotIncomingMessage(
      botMessage({ text: `message ${index}`, sourceMessageId: String(index) }),
    );
  }
  assert.equal(sessions.turns.length, BOT_CONVERSATION_RATE_BURST);
  const notice = botRegistry.sent.at(-1);
  assert.equal(notice.text, 'Maka 收到的机器人消息过于频繁，请稍后再试。');
  assert.deepEqual(notice.options, { replyToMessageId: '9', ephemeralTtlMs: 300_000 });

  clock.now += BOT_CONVERSATION_RATE_REFILL_MS - 1;
  await service.handleBotIncomingMessage(botMessage({ text: 'early', sourceMessageId: '10' }));
  assert.equal(sessions.turns.length, BOT_CONVERSATION_RATE_BURST);

  clock.now += 1;
  await service.handleBotIncomingMessage(botMessage({ text: 'refilled', sourceMessageId: '11' }));
  assert.equal(sessions.turns.length, BOT_CONVERSATION_RATE_BURST + 1);
  assert.equal(sessions.turns.at(-1).text, '[Telegram:test_user] refilled');
});

test('a photo without a caption gets a receipt and no Turn', async () => {
  const { service, botRegistry, sessions } = await routing();
  const { nonTextMessageAck } = (await maka()).botEvents;
  await service.handleBotIncomingMessage(
    botMessage({ text: '', sourceMessageId: '21', attachmentKind: 'photo' }),
  );
  assert.equal(sessions.created.length, 0);
  assert.deepEqual(botRegistry.sent, [
    {
      platform: 'telegram',
      chatId: '7001',
      text: nonTextMessageAck('photo'),
      options: { replyToMessageId: '21', ephemeralTtlMs: 300_000 },
    },
  ]);
  // Text without an attachment kind and without text is dropped silently.
  await service.handleBotIncomingMessage(botMessage({ text: '  ', sourceMessageId: '22' }));
  assert.equal(botRegistry.sent.length, 1);
});

test('reset in a direct chat starts the next message in a new Session', async () => {
  const { service, botRegistry, sessions } = await routing();
  await service.handleBotIncomingMessage(botMessage({ text: 'first', sourceMessageId: '1' }));
  await service.handleBotIncomingMessage(botMessage({ text: '重置', sourceMessageId: '2' }));
  assert.equal(botRegistry.sent.at(-1).text, '任务已重置，下一条消息会开新任务。');
  await service.handleBotIncomingMessage(botMessage({ text: 'second', sourceMessageId: '3' }));
  assert.deepEqual(
    sessions.turns.map(({ sessionId }) => sessionId),
    ['session-1', 'session-2'],
  );
});

test('a Session that went away is replaced by a new one', async () => {
  const { service, sessions } = await routing();
  await service.handleBotIncomingMessage(botMessage({ text: 'first', sourceMessageId: '1' }));
  sessions.makeUnavailable('session-1');
  await service.handleBotIncomingMessage(botMessage({ text: 'second', sourceMessageId: '2' }));
  assert.deepEqual(
    sessions.turns.map(({ sessionId }) => sessionId),
    ['session-1', 'session-2'],
  );
});

test('a failed Turn tells the chat, and a closed service says nothing', async () => {
  const failing = fakeSessions();
  failing.runTurn = async () => {
    throw new Error('network timeout');
  };
  const { service, botRegistry } = await routing({ sessions: failing });
  await service.handleBotIncomingMessage(botMessage({ text: 'hello', sourceMessageId: '1' }));
  assert.match(botRegistry.sent.at(-1).text, /^Maka 暂时无法处理这条消息：/);
  assert.equal(botRegistry.sent.at(-1).options.ephemeralTtlMs, 300_000);

  await service.close();
  await service.handleBotIncomingMessage(botMessage({ text: 'late', sourceMessageId: '2' }));
  assert.equal(botRegistry.sent.length, 1);
});
