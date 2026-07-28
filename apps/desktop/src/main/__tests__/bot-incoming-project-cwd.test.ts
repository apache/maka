import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { BotIncomingMessage, BotRegistry, SessionManager } from '@maka/runtime';
import { createBotIncomingMainService } from '../bot-incoming-main.js';

describe('bot incoming new-session cwd', () => {
  it('leaves the cwd to the shared desktop session resolver', async () => {
    let capturedCwd: unknown = undefined;
    let resolveCreated: () => void = () => {};
    const created = new Promise<void>((resolve) => {
      resolveCreated = resolve;
    });
    const service = createBotIncomingMainService({
      // createSession captures the cwd it was given, signals the test, then
      // throws to short-circuit before the streaming / typing path runs.
      runtime: {} as SessionManager,
      async createSession(input) {
        capturedCwd = input.cwd;
        resolveCreated();
        throw new Error('__short_circuit_after_create__');
      },
      botRegistry: {
        async sendMessage() {},
        async sendTypingIndicator() {
          return false;
        },
        isImplemented() {
          return true;
        },
      } as unknown as BotRegistry,
      getDefaultConnectionSlug: async () => 'slug',
      getReadyConnection: async () => ({ connection: { slug: 'slug' }, model: 'm' }),
      readSessionHeader: async () => ({ permissionMode: 'ask', isArchived: false, status: 'active' }),
      ensureSessionCanSend: async () => {},
      emitSessionsChanged() {},
      async runAgentTurn() {
        throw new Error('runAgentTurn must not be reached');
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

    // handleBotIncomingMessage returns before the queued create runs; wait
    // for createSession to actually be invoked (or time out).
    await Promise.race([
      created,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('createSession was not called')), 1000)),
    ]);

    assert.equal(capturedCwd, undefined);
  });
});
