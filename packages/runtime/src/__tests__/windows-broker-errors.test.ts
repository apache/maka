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
