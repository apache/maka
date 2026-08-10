import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  addOptimisticQueuedMessage,
  removeOptimisticQueuedMessage,
} from '../../renderer/optimistic-message-queue.js';

describe('optimistic message queue projection', () => {
  it('adds a pending entry without changing the authoritative revision', () => {
    const current = {
      session: {
        queueRevision: 7,
        paused: false,
        steering: [],
        followup: [],
      },
    };
    const next = addOptimisticQueuedMessage(current, 'session', {
      entryId: 'optimistic-1',
      messageId: 'optimistic-1',
      content: { text: 'next' },
      placement: 'next_turn',
      state: 'queued',
    });

    assert.equal(next.session?.queueRevision, 7);
    assert.equal(next.session?.followup[0]?.content.text, 'next');
    assert.equal(next.session?.pendingEntryIds?.has('optimistic-1'), true);
  });

  it('rolls back only the named pending entry and preserves accepted work', () => {
    const accepted = {
      entryId: 'accepted',
      messageId: 'accepted',
      content: { text: 'accepted' },
      placement: 'next_turn' as const,
      state: 'queued' as const,
    };
    const pending = {
      entryId: 'optimistic-1',
      messageId: 'optimistic-1',
      content: { text: 'pending' },
      placement: 'next_turn' as const,
      state: 'queued' as const,
    };
    const current = {
      session: {
        paused: false,
        steering: [],
        followup: [accepted, pending],
        pendingEntryIds: new Set(['optimistic-1']),
      },
    };
    const next = removeOptimisticQueuedMessage(current, 'session', 'optimistic-1');

    assert.deepEqual(next.session?.followup, [accepted]);
    assert.equal(next.session?.pendingEntryIds, undefined);
    assert.strictEqual(
      removeOptimisticQueuedMessage(next, 'session', 'optimistic-1'),
      next,
    );
  });
});
