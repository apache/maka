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
import { decodeGoalAuthorityRecord, type GoalAuthorityRecord } from '../goal.js';

test('Goal authority decoder rejects cross-authority execution state', () => {
  const valid = goalAuthorityRecord();
  const current = valid.currentExecution;
  assert.ok(current);
  if (!current) return;

  for (const candidate of [
    { ...valid, extra: true },
    { ...valid, activeEventWait: { waitId: 'removed-yield-gate' } },
    {
      ...valid,
      currentExecution: {
        ...current,
        execution: { ...current.execution, sessionId: 'other_session' },
      },
    },
    {
      ...valid,
      currentExecution: {
        ...current,
        checkpoint: { ...current.checkpoint, revision: valid.goal.revision + 1 },
      },
    },
    {
      ...valid,
      currentExecution: {
        ...current,
        controlLease: {
          ...current.controlLease,
          generation: valid.controlLease.generation + 1,
        },
      },
    },
    {
      ...valid,
      pendingContinuation: {
        checkpoint: { goalId: valid.goal.id, revision: valid.goal.revision },
        controlLease: valid.controlLease,
        prompt: 'continue',
      },
    },
  ]) {
    assert.throws(() => decodeGoalAuthorityRecord(candidate), TypeError);
  }
});

test('Goal authority decoder normalizes pre-outbox records', () => {
  const legacy = goalAuthorityRecord();
  const { pendingContinuation: _, ...withoutOutbox } = legacy;
  assert.equal(decodeGoalAuthorityRecord(withoutOutbox).pendingContinuation, null);
});

test('Goal authority rejects removed yielded continuation fields', () => {
  const base = goalAuthorityRecord();
  assert.throws(
    () =>
      decodeGoalAuthorityRecord({
        ...base,
        currentExecution: null,
        pendingContinuation: {
          checkpoint: { goalId: base.goal.id, revision: base.goal.revision },
          controlLease: base.controlLease,
          prompt: 'continue',
          eventWait: {},
        },
      }),
    TypeError,
  );
});

test('natural observation preparation is durable only with its original pending observation', () => {
  const base = goalAuthorityRecord();
  const pending = {
    checkpoint: { goalId: base.goal.id, revision: base.goal.revision },
    controlLease: base.controlLease,
    prompt: 'Wait for an external fact',
    triggeringTurnId: 'turn_1',
    observation: {
      waitId: 'wait_1',
      sourceRunId: 'run_1',
      completionEventId: 'completed_1',
      resource: {
        providerId: 'test',
        connectionId: null,
        resourceType: 'job',
        resourceId: 'job_1',
      },
      condition: { typeId: 'done', version: 1, parameters: {} },
      deadlineAt: null,
    },
    observationPreparation: 'pending',
  };
  const record = { ...base, currentExecution: null, pendingContinuation: pending };
  assert.equal(
    decodeGoalAuthorityRecord(record).pendingContinuation?.observationPreparation,
    'pending',
  );
  assert.throws(
    () =>
      decodeGoalAuthorityRecord({
        ...record,
        pendingContinuation: { ...pending, observation: undefined },
      }),
    TypeError,
  );
  assert.throws(
    () =>
      decodeGoalAuthorityRecord({
        ...record,
        pendingContinuation: { ...pending, observationPreparation: 'ready' },
      }),
    TypeError,
  );
});

function goalAuthorityRecord(): GoalAuthorityRecord {
  const goalId = 'goal_1';
  const sessionId = 'session_1';
  const controlLease = { goalId, generation: 2 };
  return {
    schemaVersion: 1,
    goal: {
      id: goalId,
      revision: 3,
      sessionId,
      condition: 'Finish the durable Goal.',
      status: 'active',
      setAt: 1,
      iterations: 2,
      maxIterations: 50,
      consecutiveNoProgress: 0,
      blockCap: 8,
      tokensAtStart: 10,
      tokensNow: 20,
      tokensBaselinePending: false,
    },
    controlLease,
    currentExecution: {
      execution: { sessionId, turnId: 'turn_1', runId: 'run_1' },
      checkpoint: { goalId, revision: 2 },
      controlLease: { goalId, generation: 1 },
    },
    pendingContinuation: null,
  };
}

test('retired wait settlement belongs only to the paused original Goal Turn', () => {
  const base = goalAuthorityRecord();
  const record = {
    ...base,
    goal: { ...base.goal, status: 'paused', pausedAt: 5 },
    legacyEventWaitSettlement: base.currentExecution!.execution,
  };
  assert.deepEqual(decodeGoalAuthorityRecord(record), record);
  for (const invalid of [
    { ...record, goal: { ...record.goal, status: 'active' } },
    { ...record, currentExecution: null },
    {
      ...record,
      legacyEventWaitSettlement: { ...record.legacyEventWaitSettlement, turnId: 'other' },
    },
    {
      ...record,
      legacyEventWaitSettlement: { ...record.legacyEventWaitSettlement, sessionId: 'other' },
    },
  ])
    assert.throws(() => decodeGoalAuthorityRecord(invalid));
});
