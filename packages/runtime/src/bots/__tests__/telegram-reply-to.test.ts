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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { __TEST__ } from '../telegram-bridge.js';

const { buildTelegramSendBody, normalizeTelegramReplyToMessageId, telegramMessageToEvent } =
  __TEST__;

describe('buildTelegramSendBody', () => {
  it('threads only the first chunk under a valid originating message', () => {
    assert.deepEqual(buildTelegramSendBody('chat-1', 'hello', undefined, 0), {
      chat_id: 'chat-1',
      text: 'hello',
    });
    assert.deepEqual(buildTelegramSendBody('chat-1', 'hello', { replyToMessageId: '42' }, 0), {
      chat_id: 'chat-1',
      text: 'hello',
      reply_to_message_id: 42,
      allow_sending_without_reply: true,
    });
    assert.deepEqual(
      buildTelegramSendBody('chat-1', '[2/3]\ntail', { replyToMessageId: '42' }, 1),
      { chat_id: 'chat-1', text: '[2/3]\ntail' },
    );
  });
});

describe('normalizeTelegramReplyToMessageId', () => {
  it('accepts positive safe integers and rejects malformed or unsafe values', () => {
    assert.equal(normalizeTelegramReplyToMessageId(' 42 '), 42);
    for (const value of [undefined, '0', '9007199254740992']) {
      assert.equal(normalizeTelegramReplyToMessageId(value), undefined, String(value));
    }
  });
});

it('drops Telegram payloads without a stable platform message id', () => {
  assert.equal(
    telegramMessageToEvent({ from: { id: 1 }, chat: { id: 2 }, text: 'hello' }, 123, undefined),
    null,
  );
});

it('preserves signed Telegram group and supergroup chat ids', () => {
  for (const chatId of [-123456789, -1001234567890]) {
    const event = telegramMessageToEvent(
      {
        from: { id: 1 },
        chat: { id: chatId, type: 'supergroup' },
        message_id: 42,
        text: 'hello',
      },
      123,
      undefined,
    );
    assert.equal(event?.conversationId, String(chatId));
    assert.equal(event?.replyTarget.chatId, String(chatId));
    assert.equal(event?.isGroup, true);
  }
});
