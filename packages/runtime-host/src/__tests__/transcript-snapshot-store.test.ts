import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import { TranscriptSnapshotStore } from '../server/transcript-snapshot-store.js';

test('expires idle snapshots against an injected clock', () => {
  let now = 1;
  const store = new TranscriptSnapshotStore(() => now);
  const first = store.start(snapshotInput('connection-1', 'subscription-1'));
  assert.equal(first.ok, true);
  if (!first.ok) assert.fail('expected the first transcript chunk');
  assert.equal(first.result.kind, 'chunk');
  if (first.result.kind !== 'chunk') assert.fail('expected a transcript chunk');
  assert.ok(first.result.next, 'expected a continuation cursor');
  if (!first.result.next) assert.fail('expected a continuation cursor');

  now += 60_000;
  const expired = store.continue({
    connectionId: 'connection-1',
    subscriptionId: 'subscription-1',
    snapshotId: first.result.snapshotId,
    cursor: first.result.next,
  });
  assert.deepEqual(expired, {
    ok: true,
    result: { kind: 'snapshot_expired', snapshotId: first.result.snapshotId },
  });
  store.close();
});

test('bounds retained snapshots per connection and releases them with the connection', () => {
  const store = new TranscriptSnapshotStore();
  for (let index = 0; index < 4; index += 1) {
    const started = store.start(snapshotInput('connection-1', `subscription-${index}`));
    assert.equal(started.ok, true);
  }
  const bounded = store.start(snapshotInput('connection-1', 'subscription-5'));
  assert.deepEqual(bounded, {
    ok: false,
    error: {
      code: 'operation_conflict',
      message: 'Runtime Host connection transcript snapshot limit reached',
    },
  });

  store.deleteConnection('connection-1');
  assert.equal(store.start(snapshotInput('connection-1', 'subscription-new')).ok, true);
  store.close();
});

function snapshotInput(connectionId: string, subscriptionId: string) {
  return {
    connectionId,
    subscriptionId,
    sessionId: 'session-1',
    messages: [assistantMessage('x'.repeat(30_000))],
  };
}

function assistantMessage(text: string): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id: 'assistant-1',
    turnId: 'turn-1',
    ts: 1,
    text,
    modelId: 'test-model',
  };
}
