import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMessage } from '@maka/core';
import { mergeDurableAndRuntimeMessages } from '../session-message-projection.js';

test('keeps imported durable messages when no RuntimeEvent runs exist', () => {
  assert.deepEqual(mergeDurableAndRuntimeMessages(messages('imported'), []), messages('imported'));
});

test('upserts live RuntimeEvent messages without dropping imported history', () => {
  const durable = messages('imported');
  const runtime: StoredMessage[] = [
    {
      type: 'assistant',
      id: 'assistant',
      turnId: 'turn-1',
      ts: 2,
      text: 'updated',
      modelId: 'model',
    },
    { type: 'user', id: 'follow-up', turnId: 'turn-2', ts: 3, text: 'continue' },
  ];

  assert.deepEqual(mergeDurableAndRuntimeMessages(durable, runtime), [
    durable[0],
    runtime[0],
    runtime[1],
  ]);
});

function messages(userText: string): StoredMessage[] {
  return [
    { type: 'user', id: 'user', turnId: 'turn-1', ts: 1, text: userText },
    {
      type: 'assistant',
      id: 'assistant',
      turnId: 'turn-1',
      ts: 2,
      text: 'answer',
      modelId: 'model',
    },
  ];
}
