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
import { test } from 'node:test';
import type { BotIncomingMessage, BotRegistry } from '@maka/runtime/bots';
import { slackMessageToEvent } from '@maka/runtime/bots';
import { createBotIncomingMainService } from '../bot-incoming-main.js';

// #6322: inside one Slack thread every message shares the same thread_ts.
// The bridge used that thread root as sourceMessageId, so the idempotency
// key collapsed and the second follow-up in a thread never reached a turn.
test('distinct messages in one Slack thread all reach a turn and replies stay threaded', async () => {
  const turns: string[] = [];
  const sentReplies: Array<{ text: string; replyToMessageId?: string }> = [];
  const service = createBotIncomingMainService({
    botRegistry: {
      async sendMessage(_platform: string, _chatId: string, text: string, options?: { replyToMessageId?: string }) {
        sentReplies.push({ text, replyToMessageId: options?.replyToMessageId });
        return 'bot-message';
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
      async runTurn(input: { text: string }) {
        turns.push(input.text);
        return { kind: 'completed', text: `reply ${turns.length}` };
      },
    },
  });

  const toMessage = (raw: Parameters<typeof slackMessageToEvent>[0]): BotIncomingMessage =>
    slackMessageToEvent(raw, 0) as BotIncomingMessage;

  await service.handleBotIncomingMessage(
    toMessage({ type: 'message', user: 'U123', channel: 'C456', channel_type: 'channel', text: 'question', ts: '1720000000.1' }),
  );
  await service.handleBotIncomingMessage(
    toMessage({ type: 'message', user: 'U123', channel: 'C456', channel_type: 'channel', text: 'first follow-up', ts: '1720000001.2', thread_ts: '1720000000.1' }),
  );
  await service.handleBotIncomingMessage(
    toMessage({ type: 'message', user: 'U456', channel: 'C456', channel_type: 'channel', text: 'second follow-up', ts: '1720000002.3', thread_ts: '1720000000.1' }),
  );

  assert.equal(turns.length, 3);
  assert.deepEqual(
    sentReplies.map((reply) => reply.replyToMessageId),
    ['1720000000.1', '1720000000.1', '1720000000.1'],
  );
});
