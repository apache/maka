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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotIncomingMessage, BotRegistry } from '@maka/runtime/bots';
import type { InteractionRequest } from '@maka/runtime-host/protocol';
import type { BotSessionAdapter } from '../bot-session-adapter.js';
import { createBotIncomingMainService } from '../bot-incoming-main.js';

test('Feishu approvals are scoped to the originating user and one interaction', async (t) => {
  const sent: string[] = [];
  const decisions: unknown[] = [];
  const request: InteractionRequest = {
    kind: 'sandbox_boundary',
    expansion: { network: { enabled: true } },
    justification: 'Fetch a dependency',
  };
  const sessions: BotSessionAdapter = {
    async createSession() { return 'session-1'; },
    async prepareSession() { return 'ready'; },
    async runTurn() {
      return {
        kind: 'suspended',
        pendingApprovals: [{ interactionId: 'interaction-1', turnId: 'turn-1', request }],
      };
    },
    async respondToApproval(input) {
      decisions.push(input);
      return { kind: 'completed', text: 'Task continued after approval.' };
    },
  };
  const service = createBotIncomingMainService({
    sessions,
    botRegistry: {
      async sendMessage(_platform: BotIncomingMessage['platform'], _chatId: string, text: string) {
        sent.push(text);
        return `sent-${sent.length}`;
      },
      async sendTypingIndicator() { return false; },
      isImplemented() { return true; },
    } as unknown as BotRegistry,
  });
  t.after(() => service.close());

  await service.handleBotIncomingMessage(message('alice', 'run task', 'm1'));
  const approvalText = sent.find((text) => text.includes('批准：批准 '));
  assert.ok(approvalText);
  assert.match(approvalText, /15 分钟内有效/u);
  assert.match(approvalText, /Fetch a dependency/u);
  const code = /批准：批准 ([A-F0-9]{12})/u.exec(approvalText)?.[1];
  assert.ok(code);

  await service.handleBotIncomingMessage(message('bob', `批准 ${code}`, 'm2'));
  assert.equal(decisions.length, 0);
  assert.match(sent.at(-1) ?? '', /只有发起该请求的飞书用户/u);

  await service.handleBotIncomingMessage(message('alice', `批准 ${code}`, 'm3'));
  assert.deepEqual(decisions, [{
    sessionId: 'session-1',
    interactionId: 'interaction-1',
    turnId: 'turn-1',
    request,
    decision: 'allow',
  }]);
  assert.match(sent.at(-2) ?? '', /已批准这一次请求/u);
  assert.equal(sent.at(-1), 'Task continued after approval.');

  await service.handleBotIncomingMessage(message('alice', `批准 ${code}`, 'm4'));
  assert.equal(decisions.length, 1);
  assert.match(sent.at(-1) ?? '', /不存在、已过期/u);
});

test('non-Feishu bot interactions remain desktop-only', async (t) => {
  const sent: string[] = [];
  const service = createBotIncomingMainService({
    sessions: {
      async createSession() { return 'session-1'; },
      async prepareSession() { return 'ready'; },
      async runTurn() {
        return {
          kind: 'suspended',
          pendingApprovals: [{
            interactionId: 'interaction-1',
            turnId: 'turn-1',
            request: {
              kind: 'sandbox_boundary',
              expansion: { network: { enabled: true } },
              justification: 'Fetch a dependency',
            },
          }],
        };
      },
    },
    botRegistry: {
      async sendMessage(_platform: BotIncomingMessage['platform'], _chatId: string, text: string) {
        sent.push(text);
        return 'sent';
      },
      async sendTypingIndicator() { return false; },
      isImplemented() { return true; },
    } as unknown as BotRegistry,
  });
  t.after(() => service.close());

  await service.handleBotIncomingMessage({ ...message('alice', 'run task', 'm1'), platform: 'telegram' });
  assert.deepEqual(sent, ['这条请求需要在 Maka 桌面端审批后才能继续。']);
});

function message(userId: string, text: string, sourceMessageId: string): BotIncomingMessage {
  return {
    platform: 'feishu',
    userId,
    userName: userId,
    chatId: 'chat-1',
    isGroup: false,
    text,
    sourceMessageId,
    receivedAt: Date.now(),
  };
}
