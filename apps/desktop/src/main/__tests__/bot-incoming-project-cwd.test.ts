import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { BotIncomingMessage, BotRegistry, SessionManager } from '@maka/runtime';
import { createBotIncomingMainService } from '../bot-incoming-main.js';
import { createEmbeddedBotSessionAdapter } from '../embedded-bot-session-adapter.js';

describe('bot incoming new-session cwd', () => {
  it('leaves the cwd to the shared desktop session resolver', async () => {
    let capturedCwd: unknown = undefined;
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
      sessions: createEmbeddedBotSessionAdapter({
        runtime: {} as SessionManager,
        // createSession captures the cwd it was given, then throws to
        // short-circuit before the streaming / typing path runs.
        async createSession(input) {
          capturedCwd = input.cwd;
          throw new Error('__short_circuit_after_create__');
        },
        getDefaultConnectionSlug: async () => 'slug',
        getReadyConnection: async () => ({ connection: { slug: 'slug' }, model: 'm' }),
        readSessionHeader: async () => ({
          permissionMode: 'ask',
          isArchived: false,
          status: 'active',
        }),
        ensureSessionCanSend: async () => {},
        emitSessionsChanged() {},
        async runAgentTurn() {
          throw new Error('runAgentTurn must not be reached');
        },
      }),
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

    assert.equal(capturedCwd, undefined);
  });
});
