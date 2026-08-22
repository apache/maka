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
  decodeGoalProjection,
  decodeRequestFrame,
  decodeResponseFrame,
  decodeSessionContinuitySnapshot,
  HOST_OPERATION_SPECS,
  REMOTE_OWNER_OPERATION_GRANTS,
  SESSION_CONTINUITY_SCHEMA_VERSION,
} from '../protocol/index.js';

const goal = {
  goalId: 'goal-1',
  revision: 3,
  sessionId: 'session-1',
  condition: 'Ship the complete slice',
  status: 'paused' as const,
  setAt: 1,
  iterations: 2,
  maxIterations: 50,
  consecutiveNoProgress: 0,
  blockCap: 8,
  tokenBudget: 10_000,
  tokensSpent: 500,
  lastReason: 'Waiting for an exact resume',
  achievedAt: null,
  pausedAt: 2,
};

test('Goal query and exact-revision control frames round-trip', () => {
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'request-query',
      operation: 'goal.query',
      input: { sessionId: 'session-1' },
    }),
    {
      requestId: 'request-query',
      operation: 'goal.query',
      input: { sessionId: 'session-1' },
    },
  );
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'request-control',
      operation: 'goal.control',
      input: {
        sessionId: 'session-1',
        goalId: 'goal-1',
        expectedRevision: 3,
        action: 'resume',
      },
    }),
    {
      requestId: 'request-control',
      operation: 'goal.control',
      input: {
        sessionId: 'session-1',
        goalId: 'goal-1',
        expectedRevision: 3,
        action: 'resume',
      },
    },
  );
  assert.deepEqual(
    decodeResponseFrame({
      requestId: 'request-control',
      operation: 'goal.control',
      ok: true,
      result: { sessionId: 'session-1', goal },
    }),
    {
      requestId: 'request-control',
      operation: 'goal.control',
      ok: true,
      result: { sessionId: 'session-1', goal },
    },
  );
  assert.throws(() =>
    HOST_OPERATION_SPECS['goal.control'].assertOutputForInput?.(
      {
        sessionId: 'session-1',
        goalId: 'another-goal',
        expectedRevision: 3,
        action: 'resume',
      },
      { sessionId: 'session-1', goal },
    ),
  );
});

test('Goal projection is part of the exact Session continuity schema', () => {
  const snapshot = decodeSessionContinuitySnapshot({
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running',
      createdAt: 1,
      lastUsedAt: 2,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: null,
    goal,
    queue: { hostEpoch: 'epoch-1', queueRevision: 0, steering: [], followup: [] },
    interactions: { pending: [] },
  });
  assert.deepEqual(snapshot.goal, goal);
  assert.throws(() =>
    decodeSessionContinuitySnapshot({
      ...snapshot,
      goal: { ...goal, sessionId: 'session-2' },
    }),
  );
});

test('Goal projection rejects unknown fields and text beyond the shared UTF-8 boundary', () => {
  assert.throws(() => decodeGoalProjection({ ...goal, extra: true }));
  assert.throws(() => decodeGoalProjection({ ...goal, condition: '界'.repeat(501) }));
  assert.throws(() => decodeGoalProjection({ ...goal, lastReason: '界'.repeat(501) }));
});

test('goal.arm carries an exact frame and refuses budgets outside the shared bounds', () => {
  const input = {
    sessionId: 'session-1',
    condition: 'All tests pass',
    maxIterations: 20,
    tokenBudget: 50_000,
  };
  assert.deepEqual(decodeRequestFrame({ requestId: 'request-arm', operation: 'goal.arm', input }), {
    requestId: 'request-arm',
    operation: 'goal.arm',
    input,
  });
  // "Not chosen" travels as null, so the key set stays exact either way.
  assert.deepEqual(
    decodeRequestFrame({
      requestId: 'request-arm-defaults',
      operation: 'goal.arm',
      input: { ...input, maxIterations: null, tokenBudget: null },
    }).input,
    { ...input, maxIterations: null, tokenBudget: null },
  );
  const decode = (patch: Record<string, unknown>): unknown =>
    decodeRequestFrame({
      requestId: 'request-arm',
      operation: 'goal.arm',
      input: { ...input, ...patch },
    });
  assert.throws(() => decode({ condition: '   ' }));
  assert.throws(() => decode({ condition: '界'.repeat(501) }));
  assert.throws(() => decode({ maxIterations: 201 }));
  assert.throws(() => decode({ maxIterations: 0 }));
  assert.throws(() => decode({ tokenBudget: 999 }));
  assert.throws(() => decode({ blockCap: 8 }), 'goal.arm takes no unknown field');
});

test('goal.arm answers with a Goal from the Session it was asked about', () => {
  const result = { sessionId: 'session-1', goal };
  assert.deepEqual(
    decodeResponseFrame({
      requestId: 'request-arm',
      operation: 'goal.arm',
      ok: true,
      result,
    }),
    { requestId: 'request-arm', operation: 'goal.arm', ok: true, result },
  );
  assert.throws(() =>
    decodeResponseFrame({
      requestId: 'request-arm',
      operation: 'goal.arm',
      ok: true,
      result: { sessionId: 'session-2', goal },
    }),
  );
  assert.throws(() =>
    HOST_OPERATION_SPECS['goal.arm'].assertOutputForInput?.(
      {
        sessionId: 'session-2',
        condition: 'All tests pass',
        maxIterations: null,
        tokenBudget: null,
      },
      result,
    ),
  );
});

test('a remote owner may arm a Goal, because it can already cause one', () => {
  // Withholding goal.arm would withhold nothing: a remote owner sends Turns,
  // and the model arms its own Goal with the GoalSet tool inside one. The only
  // thing a refusal here removes is the explicit path the user can see and
  // stop, so the grant sits at the same tier as goal.control.
  assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('goal.arm'), true);
  assert.equal(REMOTE_OWNER_OPERATION_GRANTS.includes('goal.control'), true);
});
