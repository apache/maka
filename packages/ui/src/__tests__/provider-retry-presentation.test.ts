import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderRetryEvent } from '@maka/core/events';
import { presentProviderRetry } from '../provider-retry-presentation.js';

test('a scheduled rate-limit retry names the reason and the wait, not a working phrase', () => {
  const retry: ProviderRetryEvent = {
    type: 'provider_retry',
    id: 'retry-1',
    turnId: 'turn-1',
    ts: 1,
    phase: 'scheduled',
    attempt: 8,
    maxAttempts: 10,
    delayMs: 40_000,
    reason: 'rate_limit',
  };

  const presented = presentProviderRetry(retry, 'zh');

  assert.equal(presented.status, 'warning');
  assert.match(presented.title, /8\/10/);
  assert.match(presented.title, /40/);
  assert.notEqual(presented.description, undefined);
  assert.notEqual(presented.description, presented.title);
});

test('a started retry keeps the same reason and drops the countdown', () => {
  const retry: ProviderRetryEvent = {
    type: 'provider_retry',
    id: 'retry-2',
    turnId: 'turn-1',
    ts: 2,
    phase: 'started',
    attempt: 8,
    maxAttempts: 10,
    reason: 'rate_limit',
  };

  const presented = presentProviderRetry(retry, 'zh');

  assert.equal(presented.status, 'warning');
  assert.match(presented.title, /8\/10/);
  assert.doesNotMatch(presented.title, /40/);
  assert.equal(presented.description, presentProviderRetry({
    ...retry,
    phase: 'scheduled',
    delayMs: 40_000,
  }, 'zh').description);
});
