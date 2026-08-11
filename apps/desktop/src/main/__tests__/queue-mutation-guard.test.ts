import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeQueueMutationInput } from '../queue-mutation-guard.js';

test('queue mutation guard normalizes update and reorder inputs', () => {
  assert.deepEqual(
    normalizeQueueMutationInput({
      expectedQueueRevision: 3,
      mutation: {
        kind: 'update',
        entryId: 'entry-1',
        text: '  edited  ',
      },
    }),
    {
      expectedQueueRevision: 3,
      mutation: {
        kind: 'update',
        entryId: 'entry-1',
        text: 'edited',
      },
    },
  );
  assert.deepEqual(
    normalizeQueueMutationInput({
      mutation: {
        kind: 'reorder',
        placement: 'next_turn',
        entryIds: ['entry-2', 'entry-1'],
      },
    }),
    {
      mutation: {
        kind: 'reorder',
        placement: 'next_turn',
        entryIds: ['entry-2', 'entry-1'],
      },
    },
  );
  assert.deepEqual(
    normalizeQueueMutationInput({ mutation: { kind: 'resume' } }),
    { mutation: { kind: 'resume' } },
  );
});

test('queue mutation guard rejects duplicate identities and empty edits', () => {
  assert.throws(
    () =>
      normalizeQueueMutationInput({
        mutation: {
          kind: 'reorder',
          placement: 'next_turn',
          entryIds: ['entry-1', 'entry-1'],
        },
      }),
    /Invalid queue order/,
  );
  assert.throws(
    () =>
      normalizeQueueMutationInput({
        mutation: {
          kind: 'update',
          entryId: 'entry-1',
          text: '',
        },
      }),
    /Invalid queued message content/,
  );
});
