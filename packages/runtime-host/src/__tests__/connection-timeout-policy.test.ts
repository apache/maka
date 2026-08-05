import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultRequestTimeoutMs } from '../client/connection.js';

test('operations with their own deadline are not preempted by the connection timeout', () => {
  assert.equal(defaultRequestTimeoutMs('subscription.open'), undefined);
  assert.equal(defaultRequestTimeoutMs('session.transcript.query'), undefined);
  assert.equal(defaultRequestTimeoutMs('web-search.execute'), undefined);
  assert.equal(defaultRequestTimeoutMs('host.status'), 2_000);
});
