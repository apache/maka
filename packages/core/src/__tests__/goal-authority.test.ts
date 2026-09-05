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
  ]) {
    assert.throws(() => decodeGoalAuthorityRecord(candidate), TypeError);
  }
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
  };
}
