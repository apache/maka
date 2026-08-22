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
import { describe, test } from 'node:test';
import {
  AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
  isAgentGraphScheduleUpdateRequest,
  type AgentGraphScheduleUpdateRequest,
} from '../agent-graph-schedule.js';

describe('agent graph schedule contract', () => {
  test('accepts explicit selected results from an earlier graph', () => {
    const request = scheduleRequest();
    request.addWork[0]!.selectedResultInputs = [
      { sourceGraphId: 'graph-previous', resultId: 'selected-result' },
    ];
    assert.equal(isAgentGraphScheduleUpdateRequest(request), true);
  });

  test('rejects ambiguous, duplicate, empty, and add-plus-finish updates', () => {
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        addWork: [
          {
            ...scheduleRequest().addWork[0],
            target: { kind: 'agent', agentId: '' },
          },
        ],
      }),
      false,
    );
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        addWork: Array.from({ length: 2 }, (_, workIndex) => ({
          ...scheduleRequest().addWork[0],
          workId: `graph_work_${String(workIndex + 1).repeat(32)}`,
          inputIds: [],
          selectedResultInputs: Array.from({ length: 33 }, (_, resultIndex) => ({
            sourceGraphId: 'graph-previous',
            resultId: `selected-${workIndex}-${resultIndex}`,
          })),
        })),
      }),
      false,
    );
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        addWork: [
          {
            ...scheduleRequest().addWork[0],
            selectedResultInputs: [{ sourceGraphId: 'graph-previous', resultId: 'result-1' }],
          },
        ],
      }),
      false,
    );
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        addWork: [
          {
            ...scheduleRequest().addWork[0],
            selectedResultInputs: [
              { sourceGraphId: 'graph-previous', resultId: 'selected-result' },
              { sourceGraphId: 'graph-previous', resultId: 'selected-result' },
            ],
          },
        ],
      }),
      false,
    );
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        addWork: [],
        stop: [],
      }),
      false,
    );
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        addWork: [],
        stop: [
          { targetId: 'work-1', reason: 'stop duplicate work' },
          { targetId: 'work-1', reason: 'stop duplicate work again' },
        ],
      }),
      false,
    );
    assert.equal(
      isAgentGraphScheduleUpdateRequest({
        ...scheduleRequest(),
        finish: { resultIds: ['result-1'], reason: 'enough evidence' },
      }),
      false,
    );
  });
});

function scheduleRequest(): AgentGraphScheduleUpdateRequest {
  return {
    schemaVersion: AGENT_GRAPH_SCHEDULE_UPDATE_SCHEMA_VERSION,
    updateId: `graph_update_${'a'.repeat(32)}`,
    updateFingerprint: `sha256:${'b'.repeat(64)}`,
    graphId: 'graph-1',
    source: {
      sessionId: 'session-main',
      runId: 'run-main',
      turnId: 'turn-main',
      toolCallId: 'tool-main',
    },
    addWork: [
      {
        workId: `graph_work_${'c'.repeat(32)}`,
        target: { kind: 'agent', agentId: 'fact-checker' },
        instruction: 'Verify the selected evidence.',
        inputIds: ['result-1'],
      },
    ],
    stop: [],
  };
}
