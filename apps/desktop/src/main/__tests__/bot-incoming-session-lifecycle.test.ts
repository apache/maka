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
import type { BotIncomingMessage } from '@maka/runtime/bots';
import { createBotIncomingMainService } from '../bot-incoming-main.js';
import { createTestBotSessionAdapter } from './bot-session-adapter-fixture.js';

test('routes one external conversation through Host resolution and stable message admission', async () => {
  const resolutions: unknown[] = [];
  const turns: unknown[] = [];
  const sent: string[] = [];
  const sessions = createTestBotSessionAdapter({
    async resolveSession(input) {
      resolutions.push(input);
      return { kind: 'ready', sessionId: 'session-1' };
    },
    async runTurn(input) {
      turns.push(input);
      return { kind: 'completed', text: 'reply' };
    },
  });
  const service = createBotIncomingMainService({
    sessions,
    botRegistry: registry(sent),
  });

  await service.handleBotIncomingMessage(message({ sourceEventId: 'source-1', text: 'first' }));
  await service.handleBotIncomingMessage(message({ sourceEventId: 'source-2', text: 'second' }));

  assert.deepEqual(
    resolutions.map((entry) => (entry as { conversationId: string }).conversationId),
    ['telegram:chat-1', 'telegram:chat-1'],
  );
  assert.equal(turns.length, 2);
  assert.equal((turns[0] as { messageId: string }).messageId.length, 68);
  assert.notEqual(
    (turns[0] as { messageId: string }).messageId,
    (turns[1] as { messageId: string }).messageId,
  );
  assert.deepEqual(sent, ['reply', 'reply']);
  await service.close();
});

test('deduplicates one source delivery in-process and retries it with the same Host message id', async () => {
  const firstIds: string[] = [];
  const event = message({ sourceEventId: 'stable-source' });
  const create = (ids: string[]) =>
    createBotIncomingMainService({
      sessions: createTestBotSessionAdapter({
        async runTurn(input) {
          ids.push(input.messageId);
          return { kind: 'completed', text: 'reply' };
        },
      }),
      botRegistry: registry([]),
    });

  const first = create(firstIds);
  await first.handleBotIncomingMessage(event);
  await first.handleBotIncomingMessage(event);
  assert.equal(firstIds.length, 1);
  await first.close();

  const successorIds: string[] = [];
  const successor = create(successorIds);
  await successor.handleBotIncomingMessage(event);
  assert.deepEqual(successorIds, firstIds);
  await successor.close();
});

test('releases a direct-message binding through a source-correlated reset operation', async () => {
  const releases: unknown[] = [];
  const sent: string[] = [];
  const service = createBotIncomingMainService({
    sessions: createTestBotSessionAdapter({
      async releaseConversation(input) {
        releases.push(input);
        return true;
      },
    }),
    botRegistry: registry(sent),
  });

  await service.handleBotIncomingMessage(message({ text: 'reset', sourceEventId: 'reset-1' }));

  assert.equal(releases.length, 1);
  assert.equal((releases[0] as { conversationId: string }).conversationId, 'telegram:chat-1');
  assert.match((releases[0] as { operationId: string }).operationId, /^bot_[a-f0-9]{64}$/);
  assert.deepEqual(sent, ['会话已重置，下一条消息会开新对话。']);
  await service.close();
});

function message(overrides: Partial<BotIncomingMessage> = {}): BotIncomingMessage {
  return {
    platform: 'telegram',
    userId: 'user-1',
    userName: 'Alice',
    conversationId: 'chat-1',
    sourceEventId: 'source-1',
    replyTarget: { chatId: 'chat-1', replyToMessageId: 'source-1' },
    isGroup: false,
    text: 'hello',
    receivedAt: 1,
    ...overrides,
  };
}

function registry(sent: string[]) {
  return {
    async sendMessage(_platform: string, _chatId: string, text: string) {
      sent.push(text);
      return 'sent';
    },
    async sendTypingIndicator() {
      return true;
    },
  } as never;
}
