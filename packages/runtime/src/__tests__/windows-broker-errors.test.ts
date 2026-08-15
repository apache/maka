import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyWindowsBrokerFailure } from '../sandbox/windows-broker-errors.js';

test('maps broker rejection codes onto worker error classification', () => {
  assert.deepEqual(
    classifyWindowsBrokerFailure(
      'maka-windows-sandbox: broker rejected request (profile_digest_mismatch): profile digest does not match',
    ),
    { reason: 'invalid_request', recoverable: false, brokerCode: 'profile_digest_mismatch' },
  );
  assert.deepEqual(
    classifyWindowsBrokerFailure('broker rejected request (nonce_replayed): nonce was replayed'),
    { reason: 'invalid_request', recoverable: true, brokerCode: 'nonce_replayed' },
  );
  assert.deepEqual(
    classifyWindowsBrokerFailure(
      'broker rejected request (appcontainer_launch_failed): CreateProcessW failed',
    ),
    { reason: 'spawn_failed', recoverable: false, brokerCode: 'appcontainer_launch_failed' },
  );
});

test('leaves unknown stderr shapes unclassified so worker_crashed is preserved', () => {
  assert.equal(classifyWindowsBrokerFailure(undefined), undefined);
  assert.equal(classifyWindowsBrokerFailure(''), undefined);
  assert.equal(classifyWindowsBrokerFailure('worker panicked at src/main.rs'), undefined);
  assert.equal(
    classifyWindowsBrokerFailure('broker rejected request (mystery_code): who knows'),
    undefined,
  );
});
