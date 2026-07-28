import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { BotIncomingMessage, BotRegistry, SessionManager } from '@maka/runtime';
import {
  GoalContinuationCoordinator,
  GoalManager,
  SessionActivityRegistry,
} from '@maka/runtime';
import type { SessionEvent } from '@maka/core';
import { createBotIncomingMainService } from '../bot-incoming-main.js';
import { startDesktopSessionTurn } from '../session-turn-stream.js';

const SESSION_ID = 'bot-session';

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('bot incoming Goal lifecycle', () => {
  test('settles a bot turn through the Desktop activity and Goal boundary', async () => {
    let now = 1;
    const manager = new GoalManager({
      generateId: () => 'goal-1',
      now: () => now++,
    });
    const coordinator = new GoalContinuationCoordinator({
      goalManager: manager,
      evaluator: {
        evaluate: async () => JSON.stringify({
          met: true,
          impossible: false,
          progress: true,
          waiting: false,
          reason: 'bot result verified',
        }),
      },
      getRecentContext: async () => 'bot result exists',
      admitTurn: () => assert.fail('an achieved Goal must not admit another turn'),
    });
    manager.create(SESSION_ID, 'bot result is verified');
    const activities = new SessionActivityRegistry();
    const replies: string[] = [];
    let runnerCalls = 0;
    let observedTurnId = '';

    const runtime = {
      async createSession() {
        return { id: SESSION_ID };
      },
      sendMessage(_sessionId: string, input: { turnId: string }) {
        observedTurnId = input.turnId;
        return (async function* (): AsyncIterable<SessionEvent> {
          yield {
            type: 'text_complete', id: 'text', turnId: input.turnId, ts: now++,
            messageId: 'assistant', text: 'Bot reply',
          };
          yield {
            type: 'complete', id: 'complete', turnId: input.turnId, ts: now++,
            stopReason: 'end_turn',
          };
        })();
      },
    } as unknown as SessionManager;

    const service = createBotIncomingMainService({
      runtime,
      createSession: (input) => runtime.createSession({ ...input, cwd: input.cwd ?? '/repo' }),
      botRegistry: {
        async sendMessage(_platform: string, _chatId: string, text: string) {
          replies.push(text);
          return 'bot-message-1';
        },
        async sendTypingIndicator() {
          return true;
        },
      } as unknown as BotRegistry,
      getDefaultConnectionSlug: async () => 'provider',
      getReadyConnection: async () => ({ connection: { slug: 'provider' }, model: 'model' }),
      readSessionHeader: async () => ({ permissionMode: 'explore', isArchived: false, status: 'active' }),
      ensureSessionCanSend: async () => {},
      emitSessionsChanged() {},
      async runAgentTurn(input) {
        runnerCalls++;
        const started = startDesktopSessionTurn({
          sessionId: input.sessionId,
          events: input.iterator,
          turnId: input.turnId,
          goalBoundary: 'external',
          activities,
          beginExternalTurn: (sessionId, turnId) => coordinator.beginExternalTurn(sessionId, turnId),
          onEvent: input.onEvent,
          onStreamError: (error) => { assert.fail(String(error)); },
          onDrained: () => {},
        });
        assert.equal(started.kind, 'started');
        const outcome = await started.completion;
        return {
          outcome,
          ...((outcome.kind === 'errored' || outcome.kind === 'suspended')
            ? { error: outcome.reason }
            : {}),
        };
      },
    });

    await service.handleBotIncomingMessage({
      platform: 'telegram',
      userId: 'user',
      userName: 'User',
      chatId: 'chat',
      isGroup: false,
      text: 'verify the result',
      sourceMessageId: 'source',
      receivedAt: now++,
    } as BotIncomingMessage);

    await waitFor(() => manager.get(SESSION_ID)?.status === 'achieved', 'bot turn did not settle its Goal');
    await waitFor(() => replies.length === 1, 'bot reply was not delivered');
    assert.equal(runnerCalls, 1);
    assert.ok(observedTurnId);
    assert.equal(activities.whenIdle(SESSION_ID), undefined);
    assert.deepEqual(replies, ['Bot reply']);

    coordinator.dispose();
    manager.dispose();
  });

});
