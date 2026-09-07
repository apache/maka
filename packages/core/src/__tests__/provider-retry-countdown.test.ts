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
import { test } from 'node:test';
import {
  providerRetryDisplaySeconds,
  providerRetryRemainingMs,
} from '../provider-retry-countdown.js';

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

test('providerRetryDisplaySeconds floors the humanized countdown at 1s', () => {
  assert.equal(providerRetryDisplaySeconds({ delayMs: 10_000 }, 60_000), 1);
  assert.equal(providerRetryDisplaySeconds({ delayMs: 300_000 }, 0), 300);
});
