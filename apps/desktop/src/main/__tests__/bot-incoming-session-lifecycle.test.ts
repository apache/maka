import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BotIncomingMessage, BotRegistry, SessionManager } from '@maka/runtime';
import type { SessionEvent } from '@maka/core';
import { createBotIncomingMainService } from '../bot-incoming-main.js';
import { SessionLifecycleError } from '../session-lifecycle.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for bot lifecycle test');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('bot session lifecycle bindings', () => {
  test('rebinds a conversation after its archived session rejects a send', async () => {
    const created: string[] = [];
    const sent: string[] = [];
    const replies: string[] = [];
    let ensureCalls = 0;
    const runtime = {
      async createSession() {
        const id = `bot-session-${created.length + 1}`;
        created.push(id);
        return { id };
      },
      sendMessage(sessionId: string, input: { turnId: string }) {
        sent.push(sessionId);
        return (async function* (): AsyncIterable<SessionEvent> {
          yield {
            type: 'text_complete',
            id: `text-${sessionId}`,
            turnId: input.turnId,
            ts: Date.now(),
            messageId: `message-${sessionId}`,
            text: `reply from ${sessionId}`,
          };
          yield { type: 'complete', id: `complete-${sessionId}`, turnId: input.turnId, ts: Date.now(), stopReason: 'end_turn' };
        })();
      },
    } as unknown as SessionManager;

    const service = createBotIncomingMainService({
      runtime,
      createSession: (input) => runtime.createSession({ ...input, cwd: input.cwd ?? '/repo' }),
      botRegistry: {
        async sendMessage(_platform: string, _chatId: string, text: string) {
          replies.push(text);
          return 'message-id';
        },
        async sendTypingIndicator() {
          return true;
        },
      } as unknown as BotRegistry,
      getDefaultConnectionSlug: async () => 'provider',
      getReadyConnection: async () => ({ connection: { slug: 'provider' }, model: 'model' }),
      readSessionHeader: async () => ({ permissionMode: 'explore', isArchived: false, status: 'active' }),
      ensureSessionCanSend: async (sessionId) => {
        ensureCalls += 1;
        if (sessionId === 'bot-session-1' && ensureCalls === 2) {
          throw new SessionLifecycleError('archived');
        }
      },
      emitSessionsChanged() {},
      runAgentTurn: async ({ iterator, turnId, onEvent }) => {
        for await (const event of iterator) onEvent(event);
        return { outcome: { kind: 'completed', turnId } } as never;
      },
    });

    const base = {
      platform: 'telegram',
      userId: 'user',
      userName: 'User',
      chatId: 'chat',
      isGroup: false,
      receivedAt: Date.now(),
    };
    await service.handleBotIncomingMessage({ ...base, text: 'first', sourceMessageId: 'source-1' } as BotIncomingMessage);
    await waitFor(() => replies.length === 1);
    await service.handleBotIncomingMessage({ ...base, text: 'second', sourceMessageId: 'source-2', receivedAt: Date.now() + 1 } as BotIncomingMessage);
    await waitFor(() => replies.length === 2);

    assert.deepEqual(created, ['bot-session-1', 'bot-session-2']);
    assert.deepEqual(sent, ['bot-session-1', 'bot-session-2']);
    assert.deepEqual(replies, ['reply from bot-session-1', 'reply from bot-session-2']);
  });
});
