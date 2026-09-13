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
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import { classifyAgentRunRecovery } from '../agent-run-recovery.js';
import { testInvocationOpening } from './invocation-fixture.js';

describe('AgentRun startup recovery', () => {
  test('fails a graph supervisor permission handoff once its live waiter is lost', () => {
    const invocation: RuntimeInvocationRecord = {
      sessionId: 'session-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      turnId: 'turn-1',
      openedAt: 1,
      opening: testInvocationOpening({
        route: {
          provenance: 'runtime',
          backendKind: 'fake',
          llmConnectionId: 'fake-connection',
          llmConnectionSlug: 'fake',
          modelId: 'fake-model',
        },
        configuration: { cwd: '/tmp/workspace' },
        root: { kind: 'agent_graph_supervisor_wake', wakeId: 'wake-1', attemptId: 'attempt-1' },
      }),
    };

    const decision = classifyAgentRunRecovery(invocation, [
      {
        type: 'permission_requested',
        id: 'op-permission_requested',
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
        ts: 2,
      },
    ]);
    assert.equal(decision?.status, 'failed');
    assert.equal(decision?.failureClass, 'app_restarted');
    assert.equal(decision?.diagnostic?.recoveryReason, 'stale_user_wait');
  });
});
