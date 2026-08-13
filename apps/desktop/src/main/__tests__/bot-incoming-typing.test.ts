import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import type { BotIncomingMessage, BotRegistry } from '@maka/runtime/bots';
import { createBotIncomingMainService } from '../bot-incoming-main.js';

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('the bot typing loop owns only its active abort listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const NativeAbortController = globalThis.AbortController;
  let typingSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'AbortController', class extends NativeAbortController {
    constructor() {
      super();
      typingSignal = this.signal;
    }
  });

  let releaseTurn: () => void = () => {};
  const turnReleased = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  let typingAttempts = 0;
  const replies: string[] = [];
  const service = createBotIncomingMainService({
    botRegistry: {
      async sendMessage(_platform: string, _chatId: string, text: string) {
        replies.push(text);
        return 'bot-message';
      },
      async sendTypingIndicator() {
        typingAttempts += 1;
        throw new Error('typing unavailable');
      },
    } as unknown as BotRegistry,
    sessions: {
      async createSession() {
        return 'bot-session';
      },
      async prepareSession() {
        return 'ready';
      },
      async runTurn() {
        await turnReleased;
        return { kind: 'completed', text: 'Bot reply' };
      },
    },
  });

  const handling = service.handleBotIncomingMessage({
    platform: 'telegram',
    userId: 'user',
    userName: 'User',
    chatId: 'chat',
    isGroup: false,
    text: 'hello',
    sourceMessageId: 'source',
    receivedAt: Date.now(),
  } as BotIncomingMessage);

  await waitFor(() => typingAttempts === 1 && typingSignal !== undefined, 'first typing attempt did not run');
  assert.equal(getEventListeners(typingSignal!, 'abort').length, 1);

  for (let expectedAttempts = 2; expectedAttempts <= 4; expectedAttempts += 1) {
    t.mock.timers.tick(3_999);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(typingAttempts, expectedAttempts - 1);

    t.mock.timers.tick(1);
    await waitFor(() => typingAttempts === expectedAttempts, `typing attempt ${expectedAttempts} did not run`);
    assert.equal(
      getEventListeners(typingSignal!, 'abort').length,
      1,
      'a completed delay must leave only the next active delay listener',
    );
  }

  releaseTurn();
  await handling;
  assert.equal(typingSignal!.aborted, true);
  assert.equal(getEventListeners(typingSignal!, 'abort').length, 0);

  t.mock.timers.tick(4_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(typingAttempts, 4, 'abort must not allow a later typing attempt');
  assert.deepEqual(replies, ['Bot reply']);
});
