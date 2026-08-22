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
import { describe, test } from 'node:test';
import type { BotIncomingMessage, BotRegistry } from '@maka/runtime/bots';
import { createBotIncomingMainService } from '../bot-incoming-main.js';
import { BotSessionUnavailableError } from '../bot-session-adapter.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for bot lifecycle test');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('bot session lifecycle bindings', () => {
  test('rebinds a conversation after its archived session rejects a send', async () => {
    const created: string[] = [];
    const sent: string[] = [];
    const replies: string[] = [];
    let ensureCalls = 0;
    const sessions = {
      async createSession() {
        const id = `bot-session-${created.length + 1}`;
        created.push(id);
        return id;
      },
      async prepareSession(sessionId: string) {
        ensureCalls += 1;
        if (sessionId === 'bot-session-1' && ensureCalls === 1) {
          throw new BotSessionUnavailableError('archived');
        }
        return 'ready' as const;
      },
      async runTurn({ sessionId }: { sessionId: string }) {
        sent.push(sessionId);
        return { kind: 'completed' as const, text: `reply from ${sessionId}` };
      },
    };

    const service = createBotIncomingMainService({
      botRegistry: {
        async sendMessage(_platform: string, _chatId: string, text: string) {
          replies.push(text);
          return 'message-id';
        },
        async sendTypingIndicator() {
          return true;
        },
      } as unknown as BotRegistry,
      sessions,
    });

    const base = {
      platform: 'telegram',
      userId: 'user',
      userName: 'User',
      chatId: 'chat',
      isGroup: false,
      receivedAt: Date.now(),
    };
    await service.handleBotIncomingMessage({ ...base, text: 'first', sourceMessageId: 'source-1' } as BotIncomingMessage);
    await waitFor(() => replies.length === 1);
    await service.handleBotIncomingMessage({ ...base, text: 'second', sourceMessageId: 'source-2', receivedAt: Date.now() + 1 } as BotIncomingMessage);
    await waitFor(() => replies.length === 2);

    assert.deepEqual(created, ['bot-session-1', 'bot-session-2']);
    assert.deepEqual(sent, ['bot-session-1', 'bot-session-2']);
    assert.deepEqual(replies, ['reply from bot-session-1', 'reply from bot-session-2']);
  });
});
