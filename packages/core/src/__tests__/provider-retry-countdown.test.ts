import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerRetryRemainingMs } from '../provider-retry-countdown.js';

test('providerRetryRemainingMs counts down from the granted length to a zero floor', () => {
  // Host-authoritative remainingMs wins over the full delay (reconnect path).
  assert.equal(
    providerRetryRemainingMs({ delayMs: 3_600_000, remainingMs: 300_000 }, 60_000),
    240_000,
  );
  // Older emitters lack remainingMs; the full delay is the fallback.
  assert.equal(providerRetryRemainingMs({ delayMs: 10_000 }, 4_000), 6_000);
  // One agreed floor across surfaces: an expired countdown reads zero.
  assert.equal(providerRetryRemainingMs({ delayMs: 10_000 }, 60_000), 0);
  // Clock jitter between emission and receipt never inflates the wait.
  assert.equal(providerRetryRemainingMs({ delayMs: 10_000 }, -500), 10_000);
});
