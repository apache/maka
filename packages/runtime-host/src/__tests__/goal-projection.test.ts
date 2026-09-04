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
import { projectGoalState } from '../server/goal-projection.js';

test('projects the identity of the Turn bound to an armed Goal', () => {
  const projection = projectGoalState(
    {
      id: 'goal-1',
      revision: 0,
      sessionId: 'session-1',
      condition: 'Ship the feature',
      status: 'active',
      setAt: 1,
      iterations: 0,
      maxIterations: 50,
      consecutiveNoProgress: 0,
      blockCap: 8,
      tokensAtStart: 0,
      tokensNow: 0,
      tokensBaselinePending: true,
      armedAt: 1,
    },
    'turn-after-arm',
  );

  assert.equal(projection.armedAt, 1);
  assert.equal(projection.boundTurnId, 'turn-after-arm');
});
