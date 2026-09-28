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
import { decodeTurnSnapshot } from '../protocol/turn.js';
import { decodeTurnProviderRetry } from '../protocol/turn-provider-retry.js';

test('decodes both provider retry phases', () => {
  const values = [
    {
      phase: 'scheduled',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 30_000,
      ts: 1_000,
      reason: 'rate_limit',
    },
    {
      phase: 'started',
      attempt: 2,
      maxAttempts: 4,
      reason: 'network',
    },
  ] as const;
  for (const value of values) assert.deepEqual(decodeTurnProviderRetry(value), value);
});

test('rejects malformed provider retry snapshots', () => {
  const invalid = [
    { phase: 'scheduled', attempt: 0, maxAttempts: 4, delayMs: 1, reason: 'rate_limit' },
    { phase: 'started', attempt: 5, maxAttempts: 4, reason: 'network' },
    { phase: 'scheduled', attempt: 1, maxAttempts: 4, delayMs: -1, reason: 'timeout' },
    { phase: 'started', attempt: 1, maxAttempts: 4, reason: 'billing' },
    { phase: 'paused', attempt: 1, maxAttempts: 4, reason: 'network' },
  ];
  for (const value of invalid) assert.throws(() => decodeTurnProviderRetry(value));
});

test('accepts a retry only on a live Turn snapshot', () => {
  const live = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    runId: 'run-1',
    status: 'running',
    providerRetry: {
      phase: 'scheduled',
      attempt: 2,
      maxAttempts: 4,
      delayMs: 30_000,
      reason: 'rate_limit',
    },
  } as const;
  assert.deepEqual(decodeTurnSnapshot(live), live);
  assert.throws(() =>
    decodeTurnSnapshot({
      ...live,
      status: 'completed',
      terminalEventId: 'terminal-1',
    }),
  );
});
