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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { GoalState, GoalStatus } from '@maka/core/goal';
import {
  isLiveGoal,
  readGoalBudget,
} from '../../renderer/features/goals/testing.js';

function goal(status: GoalStatus, pausedAt?: number): GoalState {
  return {
    id: 'goal-1',
    revision: 1,
    sessionId: 'session-1',
    condition: 'Finish the refactor',
    status,
    setAt: 1,
    iterations: 2,
    maxIterations: 10,
    consecutiveNoProgress: 0,
    blockCap: 3,
    tokensAtStart: 0,
    tokensNow: 50,
    tokensBaselinePending: false,
    ...(pausedAt === undefined ? {} : { pausedAt }),
  };
}

describe('Goals model', () => {
  it('parses only whole, bounded, safe budget values', () => {
    assert.deepEqual(readGoalBudget('  ', 1, 10), { kind: 'empty' });
    assert.deepEqual(readGoalBudget('7', 1, 10), { kind: 'value', value: 7 });
    for (const invalid of ['0', '11', '-1', '1.5', '1e2', '9007199254740992']) {
      assert.deepEqual(readGoalBudget(invalid, 1, 10), { kind: 'invalid' });
    }
  });

  it('projects only running and well-formed paused Goals', () => {
    assert.equal(isLiveGoal(goal('active')), true);
    assert.equal(isLiveGoal(goal('waiting')), true);
    assert.equal(isLiveGoal(goal('paused', 12)), true);
    assert.equal(isLiveGoal(goal('paused')), false);
    assert.equal(isLiveGoal(goal('paused', Number.NaN)), false);
    assert.equal(isLiveGoal(goal('achieved')), false);
    assert.equal(isLiveGoal(goal('cleared')), false);
  });
});
