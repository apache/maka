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
import type { BotIncomingMessage, BotRegistry } from '@maka/runtime/bots';
import { createBotIncomingMainService } from '../bot-incoming-main.js';

describe('bot incoming new-session cwd', () => {
  it('leaves the cwd to the shared desktop session resolver', async () => {
    let createInput: unknown;
    const service = createBotIncomingMainService({
      botRegistry: {
        async sendMessage() {},
        async sendTypingIndicator() {
          return false;
        },
        isImplemented() {
          return true;
        },
      } as unknown as BotRegistry,
      sessions: {
        async createSession(input) {
          createInput = input;
          throw new Error('__short_circuit_after_create__');
        },
        async prepareSession() {
          throw new Error('prepareSession must not be reached');
        },
        async runTurn() {
          throw new Error('runTurn must not be reached');
        },
      },
    });

    await service.handleBotIncomingMessage({
      platform: 'telegram',
      userId: 'u',
      userName: 'U',
      chatId: 'c1',
      isGroup: false,
      text: 'hello',
      sourceMessageId: '',
      receivedAt: Date.now(),
    } as unknown as BotIncomingMessage);

    assert.deepEqual(createInput, {
      name: 'Telegram 任务',
      labels: ['bot', 'telegram'],
    });
  });
});
