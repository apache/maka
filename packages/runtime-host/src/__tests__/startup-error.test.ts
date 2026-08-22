/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
  assert.match(error.message, /did not become ready before the startup deadline/u);
});

test('tells both timeout reasons how to widen the election window', () => {
  assert.match(
    runtimeHostStartupError('host_unresponsive').message,
    /MAKA_RUNTIME_HOST_ELECTION_DEADLINE_MS/u,
  );
  assert.match(
    runtimeHostStartupError('startup_timeout').message,
    /MAKA_RUNTIME_HOST_ELECTION_DEADLINE_MS/u,
  );
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
