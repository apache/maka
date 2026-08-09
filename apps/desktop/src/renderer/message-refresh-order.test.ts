import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageRefreshOrder } from './message-refresh-order.js';

test('rejects an older transcript read that completes after a newer successful read', () => {
  const order = createMessageRefreshOrder();
  const older = order.begin('session-1');
  const newer = order.begin('session-1');

  assert.equal(order.acceptSuccessful(newer), true);
  assert.equal(order.acceptSuccessful(older), false);
});

test('allows an older successful read when a newer read never succeeded', () => {
  const order = createMessageRefreshOrder();
  const older = order.begin('session-1');
  order.begin('session-1');

  assert.equal(order.acceptSuccessful(older), true);
});

test('tracks transcript progress independently for each session', () => {
  const order = createMessageRefreshOrder();
  const firstSessionOlder = order.begin('session-1');
  const firstSessionNewer = order.begin('session-1');
  const secondSession = order.begin('session-2');

  assert.equal(order.acceptSuccessful(firstSessionNewer), true);
  assert.equal(order.acceptSuccessful(secondSession), true);
  assert.equal(order.acceptSuccessful(firstSessionOlder), false);
});
