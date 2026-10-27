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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTurnOrigin } from '../turn-origin.js';

test('rejects empty-string ids in the variants that only checked the string type', () => {
  // Every id field must hold a non-empty string, matching the
  // external_connector and workhub_result variants' existing strictness.
  const cases: readonly (readonly [label: string, origin: Record<string, unknown>])[] = [
    ['scheduled_task.scheduledTaskId', { kind: 'scheduled_task', scheduledTaskId: '' }],
    ['cloud_activation.activationId', { kind: 'cloud_activation', activationId: '' }],
    ['legacy_automation.automationId', { kind: 'legacy_automation', automationId: '' }],
    ['automation (released alias).automationId', { kind: 'automation', automationId: '' }],
    ['goal.goalId', { kind: 'goal', goalId: '' }],
    [
      'agent_graph.graphId',
      { kind: 'agent_graph', graphId: '', wakeId: 'wake-1', attemptId: 'attempt-1' },
    ],
    [
      'agent_graph.wakeId',
      { kind: 'agent_graph', graphId: 'graph-1', wakeId: '', attemptId: 'attempt-1' },
    ],
    [
      'agent_graph.attemptId',
      { kind: 'agent_graph', graphId: 'graph-1', wakeId: 'wake-1', attemptId: '' },
    ],
  ];
  for (const [label, origin] of cases) {
    assert.equal(decodeTurnOrigin(origin), undefined, label);
  }
});
