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
import {
  BOT_PLAINTEXT_HELP_COMMANDS,
  BOT_PLAINTEXT_RESET_COMMANDS,
  botConversationKey,
  botSourceEventKey,
  formatBotMessageForSession,
  isPlaintextHelpCommand,
  isPlaintextResetCommand,
  type BotMessageEvent,
} from '../bot-events.js';

describe('bot event contract', () => {
  const message: BotMessageEvent = {
    platform: 'telegram',
    userId: 'u1',
    userName: ' Alice\u0000 ',
    chatId: 'chat-1',
    isGroup: false,
    text: '  hello  ',
    sourceMessageId: 'm1',
    receivedAt: 1_700_000_000_000,
  };

  test('derives sanitized session text and stable keys', () => {
    assert.equal(botConversationKey(message), 'telegram:chat-1');
    assert.equal(botSourceEventKey(message), 'telegram:chat-1:m1');
    assert.equal(botSourceEventKey({ ...message, sourceMessageId: '   ' }), undefined);
    assert.equal(formatBotMessageForSession(message), '[Telegram:Alice] hello');
  });

  test('recognizes only exact plaintext commands in direct messages', () => {
    assert.equal(isPlaintextResetCommand({ isGroup: false, text: '  RESET  ' }), true);
    assert.equal(isPlaintextHelpCommand({ isGroup: false, text: '帮助' }), true);
    assert.equal(isPlaintextHelpCommand({ isGroup: true, text: 'help' }), false);
    assert.equal(isPlaintextHelpCommand({ isGroup: false, text: 'please help' }), false);
    assert.equal(isPlaintextHelpCommand({ isGroup: false, text: '   ' }), false);
    for (const phrase of BOT_PLAINTEXT_HELP_COMMANDS) {
      assert.equal(BOT_PLAINTEXT_RESET_COMMANDS.includes(phrase), false);
    }
  });
});
