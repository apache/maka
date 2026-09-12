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
import {
  classifyPendingInteractionKind,
  hostExecutionProjection,
  parentTaskStatusFromFacts,
  visibleParentTaskStatus,
  type HostPendingInteractionKind,
} from '../../renderer/features/workbar/testing.js';

const ALL_KINDS: readonly HostPendingInteractionKind[] = [
  'permission',
  'question',
  'form',
  'sandbox_boundary',
  'client_capability',
];

const runningTurn = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  runId: 'run-1',
  status: 'running' as const,
};

describe('parentTaskStatusFromFacts', () => {
  it('classifies every canonical pending kind as input or approval', () => {
    const classified = Object.fromEntries(
      ALL_KINDS.map((kind) => [kind, classifyPendingInteractionKind(kind)]),
    );
    assert.deepEqual(classified, {
      permission: 'approval',
      question: 'input',
      form: 'input',
      sandbox_boundary: 'approval',
      client_capability: 'approval',
    });
  });

  it('maps pending question and form to waiting input', () => {
    for (const kind of ['question', 'form'] as const) {
      assert.equal(
        parentTaskStatusFromFacts({
          execution: hostExecutionProjection(true, runningTurn, [kind]),
          latestTurnRead: { status: 'pending' },
        }),
        'waiting_input',
      );
    }
  });

  it('maps pending permission, sandbox, and client capability to waiting approval', () => {
    for (const kind of ['permission', 'sandbox_boundary', 'client_capability'] as const) {
      assert.equal(
        parentTaskStatusFromFacts({
          execution: hostExecutionProjection(true, runningTurn, [kind]),
          latestTurnRead: { status: 'pending' },
        }),
        'waiting_approval',
      );
    }
  });

  it('maps mixed input and approval pending kinds together', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, runningTurn, ['form', 'permission']),
        latestTurnRead: { status: 'pending' },
      }),
      'waiting_input_and_approval',
    );
  });

  it('maps a live root turn without pending interactions to running', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, {
          ...runningTurn,
          status: 'waiting_for_user',
        }),
        latestTurnRead: { status: 'pending' },
      }),
      'running',
    );
  });

  it('labels terminal root turns as the latest parent turn', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, {
          ...runningTurn,
          status: 'completed',
          terminalEventId: 'done',
        }),
        latestTurnRead: { status: 'pending' },
      }),
      'last_turn_completed',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, {
          ...runningTurn,
          status: 'failed',
          terminalEventId: 'fail',
          failureClass: 'provider',
        }),
        latestTurnRead: { status: 'pending' },
      }),
      'last_turn_failed',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, {
          ...runningTurn,
          status: 'cancelled',
          terminalEventId: 'stop',
          abortSource: 'user_stop',
        }),
        latestTurnRead: { status: 'pending' },
      }),
      'last_turn_interrupted',
    );
  });

  it('does not treat an idle session with no turns as completed', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'ready', turn: null },
      }),
      'idle',
    );
    assert.equal(
      visibleParentTaskStatus('idle'),
      null,
    );
  });

  it('uses the latest TurnRecord when rootTurn is empty', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'ready', turn: { status: 'completed' } },
      }),
      'last_turn_completed',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'ready', turn: { status: 'failed' } },
      }),
      'last_turn_failed',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'ready', turn: { status: 'aborted' } },
      }),
      'last_turn_interrupted',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'ready', turn: { status: 'running' } },
      }),
      'unavailable',
    );
  });


  it('does not keep a previous success when observation is unavailable', () => {
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(false, {
          ...runningTurn,
          status: 'completed',
          terminalEventId: 'done',
        }),
        latestTurnRead: { status: 'ready', turn: { status: 'completed' } },
      }),
      'unavailable',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: undefined,
        latestTurnRead: { status: 'ready', turn: { status: 'completed' } },
      }),
      'unavailable',
    );
    assert.equal(
      parentTaskStatusFromFacts({
        execution: hostExecutionProjection(true, null),
        latestTurnRead: { status: 'failed' },
      }),
      'unavailable',
    );
  });
});
