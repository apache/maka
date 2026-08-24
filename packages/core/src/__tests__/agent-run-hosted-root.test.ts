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
import { agentRunMatchesHostedRootExecution, type AgentRunHeader } from '../agent-run.js';

test('regenerate hosted root identity requires both source lineage fields', () => {
  const run: AgentRunHeader = {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-2',
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    parentTurnId: 'turn-1',
    regeneratedFromTurnId: 'turn-1',
  };

  assert.equal(
    agentRunMatchesHostedRootExecution(run, {
      kind: 'regenerate',
      sourceTurnId: 'turn-1',
    }),
    true,
  );
  assert.equal(
    agentRunMatchesHostedRootExecution(
      { ...run, regeneratedFromTurnId: 'turn-other' },
      { kind: 'regenerate', sourceTurnId: 'turn-1' },
    ),
    false,
  );
  assert.equal(
    agentRunMatchesHostedRootExecution(
      { ...run, scheduledTaskId: 'scheduled-task-1' },
      { kind: 'regenerate', sourceTurnId: 'turn-1' },
    ),
    false,
  );
});

test('context compact hosted root identity rejects message lineage', () => {
  const run: AgentRunHeader = {
    runId: 'run-compact',
    sessionId: 'session-1',
    turnId: 'turn-compact',
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
    rootExecutionKind: 'context_compact',
  };

  assert.equal(agentRunMatchesHostedRootExecution(run, { kind: 'context_compact' }), true);
  const { rootExecutionKind: _, ...ordinaryRun } = run;
  assert.equal(agentRunMatchesHostedRootExecution(ordinaryRun, { kind: 'context_compact' }), false);
  assert.equal(
    agentRunMatchesHostedRootExecution(
      { ...run, parentTurnId: 'turn-1' },
      { kind: 'context_compact' },
    ),
    false,
  );
});
