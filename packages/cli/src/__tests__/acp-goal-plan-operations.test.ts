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
import { RequestError } from '@agentclientprotocol/sdk';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
} from '@maka/runtime-host/client';
import { AcpGoalPlanOperations, type GoalPlanOperationPort } from '../acp/goal-plan-operations.js';
import type { AcpLoadContext, AcpSessionRegistryConnection } from '../acp/session-registry.js';
import { AcpAdmittedTurnObservation } from '../acp/turn-observation.js';

const context: AcpLoadContext = { signal: new AbortController().signal, notify: async () => {} };

test('dispatched Goal arm keeps its observation and never infers success from equal content', async () => {
  let requests = 0;
  let commits = 0;
  let rollbacks = 0;
  const operations = new AcpGoalPlanOperations(
    port(
      async () => {
        requests += 1;
        throw new RuntimeHostRequestInterruptedError(
          'goal.arm',
          'control',
          'dispatched',
          'connection_lost',
        );
      },
      () => {
        commits += 1;
      },
      () => {
        rollbacks += 1;
      },
    ),
  );
  await assert.rejects(
    operations.goalArm(
      { sessionId: 'session-1', condition: 'Finish', maxIterations: null, tokenBudget: null },
      context,
    ),
    (error: unknown) =>
      error instanceof RequestError &&
      (error.data as { code?: string; dispatch?: string }).code === 'outcome_unknown' &&
      (error.data as { dispatch?: string }).dispatch === 'dispatched',
  );
  assert.deepEqual([requests, commits, rollbacks], [1, 1, 0]);
});

test('Plan start preserves the caller turnId on a lost result and queries admission once', async () => {
  let requests = 0;
  let reconciliations = 0;
  let commits = 0;
  const observation = new AcpAdmittedTurnObservation({
    sessionId: 'session-1',
    turnId: 'turn-1',
    notify: async () => {},
  });
  const operations = new AcpGoalPlanOperations(
    port(
      async () => {
        requests += 1;
        throw new RuntimeHostRequestInterruptedError(
          'plan.turn.start',
          'command',
          'dispatched',
          'connection_lost',
        );
      },
      () => {
        commits += 1;
      },
      () => assert.fail('must retain observation'),
      observation,
      () => {
        reconciliations += 1;
      },
    ),
  );
  await assert.rejects(
    operations.planTurnStart(
      {
        kind: 'approve_proposal',
        sessionId: 'session-1',
        proposalId: 'proposal-1',
        expectedRevision: 1,
        expectedStoreVersion: 1,
        turnId: 'turn-1',
      },
      context,
    ),
    (error: unknown) =>
      error instanceof RequestError && (error.data as { turnId?: string }).turnId === 'turn-1',
  );
  assert.deepEqual([requests, reconciliations, commits], [1, 1, 1]);
  assert.equal(observation.admission.dispatchStarted, true);
  observation.dispose();
});

test('definite Plan control conflict rolls back without changing operation identity', async () => {
  let rollbacks = 0;
  const operations = new AcpGoalPlanOperations(
    port(
      async () => {
        throw new RuntimeHostOperationError(
          'plan.control',
          'operation_conflict',
          'stale operation',
        );
      },
      () => assert.fail('must not commit'),
      () => {
        rollbacks += 1;
      },
    ),
  );
  await assert.rejects(
    operations.planControl(
      {
        kind: 'request_revision',
        sessionId: 'session-1',
        proposalId: 'proposal-1',
        operationId: 'operation-1',
      },
      context,
    ),
    (error: unknown) =>
      error instanceof RequestError &&
      (error.data as { code?: string }).code === 'operation_conflict',
  );
  assert.equal(rollbacks, 1);
});

function port(
  request: () => Promise<never>,
  commit: () => void,
  rollback: () => void,
  observation?: AcpAdmittedTurnObservation,
  reconcileAdmission?: () => void,
): GoalPlanOperationPort {
  return {
    prepare: async () => ({
      connection: { request } as unknown as AcpSessionRegistryConnection,
      ...(observation ? { observation } : {}),
      ...(reconcileAdmission ? { reconcileAdmission } : {}),
      commit,
      rollback,
    }),
    assertCurrent: () => {},
    mapError: (error, operation) =>
      RequestError.internalError({
        source: 'runtime_host',
        operation,
        code: error instanceof RuntimeHostOperationError ? error.code : 'internal_failure',
      }),
  };
}
