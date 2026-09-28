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
import {
  projectProviderRetryChange,
  seedProviderRetry,
} from '../adapter/provider-retry-projector.js';
import type { LiveTurnSnapshot, TurnProviderRetry } from '../protocol/index.js';

const ROOT: Omit<LiveTurnSnapshot, 'providerRetry'> = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  runId: 'run-1',
  status: 'running',
};

test('projects retry snapshots into clock-safe client events', () => {
  const cases: Array<{
    retry: TurnProviderRetry;
    now: number;
    expected: Record<string, unknown>;
  }> = [
    {
      retry: {
        phase: 'scheduled',
        attempt: 2,
        maxAttempts: 4,
        delayMs: 30_000,
        ts: 12_000,
        reason: 'rate_limit',
      },
      now: 17_000,
      expected: { phase: 'scheduled', delayMs: 30_000, remainingMs: 25_000 },
    },
    {
      retry: {
        phase: 'scheduled',
        attempt: 2,
        maxAttempts: 4,
        delayMs: 30_000,
        ts: 12_000,
        reason: 'rate_limit',
      },
      now: 10_000,
      expected: { phase: 'scheduled', delayMs: 30_000, remainingMs: 30_000 },
    },
    {
      retry: {
        phase: 'started',
        attempt: 2,
        maxAttempts: 4,
        reason: 'network',
      },
      now: 17_000,
      expected: { phase: 'started' },
    },
  ];

  for (const { retry, now, expected } of cases) {
    const event = seedProviderRetry({ ...ROOT, providerRetry: retry }, now);
    assert.ok(event);
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(expected).map((key) => [key, event[key as keyof typeof event]]),
      ),
      expected,
    );
  }
});

test('emits only a changed retry for the same live run', () => {
  const scheduled: TurnProviderRetry = {
    phase: 'scheduled',
    attempt: 2,
    maxAttempts: 4,
    delayMs: 1_000,
    ts: 100,
    reason: 'timeout',
  };
  const current = { ...ROOT, providerRetry: scheduled };

  assert.equal(projectProviderRetryChange(current, current, 200), undefined);
  assert.equal(projectProviderRetryChange(current, { ...ROOT }, 200), undefined);
  assert.equal(
    projectProviderRetryChange(
      current,
      {
        ...ROOT,
        providerRetry: { ...scheduled, phase: 'started' },
      },
      200,
    )?.phase,
    'started',
  );
});
