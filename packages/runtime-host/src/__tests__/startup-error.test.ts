import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeHostPermanentReconnectError } from '../client/reconnect-lifecycle.js';
import { runtimeHostStartupError } from '../client/startup-error.js';

test('presents stored-data startup failures as actionable and permanent', () => {
  const error = runtimeHostStartupError('stored_data_incompatible');
  assert.ok(error instanceof RuntimeHostPermanentReconnectError);
  assert.match(error.message, /cannot read part of this workspace/u);
  assert.match(error.message, /STORED_DATA_INCOMPATIBLE/u);
});

test('presents migration blockers with a permanent previous-release recovery path', () => {
  const error = runtimeHostStartupError('operational_state_migration_blocked');
  assert.ok(error instanceof RuntimeHostPermanentReconnectError);
  assert.match(error.message, /previous Maka release/u);
  assert.match(error.message, /OPERATIONAL_STATE_MIGRATION_BLOCKED/u);
});

test('keeps an unresponsive Host retryable', () => {
  const error = runtimeHostStartupError('host_unresponsive', {
    deadlineMs: 45_000,
    elapsedMs: 45_001,
    candidateLaunches: 1,
    sawEndpointConnected: true,
    observations: {
      notRegistered: 1,
      connectFailed: 0,
      handshakeFailed: 2,
      connected: 1,
      readyWaitFailed: 1,
      deadlineElapsed: 1,
    },
    lastRegistration: {
      pid: 42,
      state: 'recovering',
      lifecycleMode: 'ephemeral',
      generation: '0.1.11',
    },
    latestCandidate: {
      pid: 42,
      startupAttemptId: '00000000-0000-4000-8000-000000000001',
      state: 'running',
    },
  });
  assert.equal(error instanceof RuntimeHostPermanentReconnectError, false);
  assert.match(error.message, /stopped responding/u);
  assert.match(error.message, /election diagnostic/u);
  assert.match(error.message, /"state":"recovering"/u);
  assert.match(error.message, /"startupAttemptId":"00000000/u);
});

test('includes bounded election evidence when startup times out before an endpoint appears', () => {
  const error = runtimeHostStartupError('startup_timeout', {
    deadlineMs: 12_000,
    elapsedMs: 12_001,
    candidateLaunches: 1,
    sawEndpointConnected: false,
    observations: {
      notRegistered: 4,
      connectFailed: 0,
      handshakeFailed: 0,
      connected: 0,
      readyWaitFailed: 0,
      deadlineElapsed: 0,
    },
    latestCandidate: {
      pid: 42,
      startupAttemptId: '00000000-0000-4000-8000-000000000001',
      state: 'running',
    },
  });

  assert.match(error.message, /did not become ready/u);
  assert.match(error.message, /"sawEndpointConnected":false/u);
  assert.match(error.message, /"candidateLaunches":1/u);
});

test('keeps internal startup failures retryable', () => {
  const error = runtimeHostStartupError('internal_startup_failure');
  assert.equal(error instanceof RuntimeHostPermanentReconnectError, false);
});

test('presents Local IPC security failures distinctly without making them permanent', () => {
  const error = runtimeHostStartupError('local_ipc_security_failed');
  assert.equal(error instanceof RuntimeHostPermanentReconnectError, false);
  assert.match(error.message, /LOCAL_IPC_SECURITY_FAILED/u);
});
