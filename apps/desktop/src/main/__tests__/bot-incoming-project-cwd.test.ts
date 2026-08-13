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
      name: 'Telegram 对话',
      labels: ['bot', 'telegram'],
    });
  });
});
