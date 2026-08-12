import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { BotIncomingMessage, BotRegistry } from '@maka/runtime/bots';
import { createBotIncomingMainService } from '../bot-incoming-main.js';
import { createTestBotSessionAdapter } from './bot-session-adapter-fixture.js';

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
      sessions: createTestBotSessionAdapter({
        async resolveSession(input) {
          createInput = input;
          return { kind: 'permission_refused' };
        },
        async runTurn() {
          throw new Error('runTurn must not be reached');
        },
      }),
    });

    await service.handleBotIncomingMessage({
      platform: 'telegram',
      userId: 'u',
      userName: 'U',
      conversationId: 'c1',
      sourceEventId: 'source-1',
      replyTarget: { chatId: 'c1', replyToMessageId: 'source-1' },
      isGroup: false,
      text: 'hello',
      receivedAt: Date.now(),
    } as unknown as BotIncomingMessage);

    assert.deepEqual(createInput, {
      conversationId: 'telegram:c1',
      name: 'Telegram 任务',
      labels: ['bot', 'telegram'],
    });
  });
});
