import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageContent, SessionEvent } from '@maka/core';
import { startDesktopMessageQueueChain } from '../desktop-message-queue.js';

test('desktop message queue opens queued followups serially after successful turns', async () => {
  const followups = [
    { text: 'second', quotes: [{ text: 'context' }] },
    { text: 'third' },
  ];
  const started: Array<{ turnId: string; content: MessageContent }> = [];
  const streamed: string[] = [];
  let nextId = 1;

  startDesktopMessageQueueChain({
    initialTurnId: 'turn-1',
    initialEvents: emptyEvents(),
    streamTurn: async (turnId) => {
      streamed.push(turnId);
      return { ok: true };
    },
    takeFollowup: () => followups.shift() ?? null,
    newTurnId: () => `turn-${++nextId}`,
    startFollowup: (turnId, content) => {
      started.push({ turnId, content });
      return emptyEvents();
    },
    onError: (error) => {
      throw error;
    },
  });

  for (let attempt = 0; attempt < 20 && streamed.length < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.deepEqual(streamed, ['turn-1', 'turn-2', 'turn-3']);
  assert.deepEqual(started, [
    { turnId: 'turn-2', content: { text: 'second', quotes: [{ text: 'context' }] } },
    { turnId: 'turn-3', content: { text: 'third' } },
  ]);
});

test('desktop message queue leaves queued work parked after a failed turn', async () => {
  let takeCalls = 0;
  startDesktopMessageQueueChain({
    initialTurnId: 'turn-1',
    initialEvents: emptyEvents(),
    streamTurn: async () => ({ ok: false }),
    takeFollowup: () => {
      takeCalls += 1;
      return { text: 'must stay queued' };
    },
    newTurnId: () => 'turn-2',
    startFollowup: () => emptyEvents(),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(takeCalls, 0);
});

async function* emptyEvents(): AsyncIterable<SessionEvent> {}
