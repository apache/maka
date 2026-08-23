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
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import type { BotIncomingMessage, BotRegistry } from '@maka/runtime/bots';
import { createBotIncomingMainService } from '../bot-incoming-main.js';

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('the bot typing loop owns only its active abort listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const NativeAbortController = globalThis.AbortController;
  let typingSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'AbortController', class extends NativeAbortController {
    constructor() {
      super();
      typingSignal = this.signal;
    }
  });

  let releaseTurn: () => void = () => {};
  const turnReleased = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let typingAttempts = 0;
  const replies: string[] = [];
  const service = createBotIncomingMainService({
    botRegistry: {
      async sendMessage(_platform: string, _chatId: string, text: string) {
        replies.push(text);
        return 'bot-message';
      },
      async sendTypingIndicator() {
        typingAttempts += 1;
        throw new Error('typing unavailable');
      },
    } as unknown as BotRegistry,
    sessions: {
      async createSession() {
        return 'bot-session';
      },
      async prepareSession() {
        return 'ready';
      },
      async runTurn() {
        await turnReleased;
        return { kind: 'completed', text: 'Bot reply' };
      },
    },
  });

  const handling = service.handleBotIncomingMessage({
    platform: 'telegram',
    userId: 'user',
    userName: 'User',
    chatId: 'chat',
    isGroup: false,
    text: 'hello',
    sourceMessageId: 'source',
    receivedAt: Date.now(),
  } as BotIncomingMessage);

  await waitFor(() => typingAttempts === 1 && typingSignal !== undefined, 'first typing attempt did not run');
  assert.equal(getEventListeners(typingSignal!, 'abort').length, 1);

  for (let expectedAttempts = 2; expectedAttempts <= 4; expectedAttempts += 1) {
    t.mock.timers.tick(3_999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(typingAttempts, expectedAttempts - 1);

    t.mock.timers.tick(1);
    await waitFor(() => typingAttempts === expectedAttempts, `typing attempt ${expectedAttempts} did not run`);
    assert.equal(
      getEventListeners(typingSignal!, 'abort').length,
      1,
      'a completed delay must leave only the next active delay listener',
    );
  }

  releaseTurn();
  await handling;
  assert.equal(typingSignal!.aborted, true);
  assert.equal(getEventListeners(typingSignal!, 'abort').length, 0);

  t.mock.timers.tick(4_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typingAttempts, 4, 'abort must not allow a later typing attempt');
  assert.deepEqual(replies, ['Bot reply']);
});

test('streams reply snapshots and persists the final reply through one channel stream', async () => {
  const updates: string[] = [];
  const finals: string[] = [];
  let fallbackSends = 0;
  const service = createBotIncomingMainService({
    botRegistry: {
      startReplyStream(
        _platform: string,
        _chatId: string,
        options: { isGroup: boolean; streamId: string },
      ) {
        assert.equal(options.isGroup, false);
        assert.match(options.streamId, /^[0-9a-f-]{36}$/);
        return {
          update(text: string) {
            updates.push(text);
          },
          async finish(text: string) {
            finals.push(text);
            return 'bot-message';
          },
          async abort() {},
        };
      },
      async sendMessage() {
        fallbackSends += 1;
        return 'fallback-message';
      },
      async sendTypingIndicator() {
        return true;
      },
    } as unknown as BotRegistry,
    sessions: {
      async createSession() {
        return 'bot-session';
      },
      async prepareSession() {
        return 'ready';
      },
      async runTurn(input) {
        input.onReplySnapshot?.('Hello');
        input.onReplySnapshot?.('Hello world');
        return { kind: 'completed', text: 'Hello world' };
      },
    },
  });

  await service.handleBotIncomingMessage({
    platform: 'telegram',
    userId: 'user',
    userName: 'User',
    chatId: 'chat',
    isGroup: false,
    text: 'hello',
    sourceMessageId: 'source',
    receivedAt: Date.now(),
  } as BotIncomingMessage);

  assert.deepEqual(updates, ['Hello', 'Hello world']);
  assert.deepEqual(finals, ['Hello world']);
  assert.equal(fallbackSends, 0);
});
