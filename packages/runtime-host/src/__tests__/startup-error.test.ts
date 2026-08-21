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
  const error = runtimeHostStartupError('host_unresponsive');
  assert.equal(error instanceof RuntimeHostPermanentReconnectError, false);
  assert.match(error.message, /stopped responding/u);
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
