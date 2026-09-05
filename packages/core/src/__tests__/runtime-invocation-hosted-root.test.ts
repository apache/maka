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
import { invocationMatchesHostedRootExecution } from '../runtime-invocation.js';
import type {
  RuntimeEventInvocationOpenedContent,
  RuntimeInvocationLineage,
  RuntimeInvocationOpenSource,
  RuntimeInvocationRootAuthority,
} from '../runtime-event.js';

const BOUNDARY_DIGEST = `sha256:${'a'.repeat(64)}` as const;

function invocation(
  root: RuntimeInvocationRootAuthority,
  overrides: {
    invocationId?: string;
    source?: RuntimeInvocationOpenSource;
    lineage?: RuntimeInvocationLineage;
    orchestrationMode?: 'default' | 'graph';
    orchestrationSource?: 'session' | 'turn_override';
  } = {},
): { invocationId: string; opening: RuntimeEventInvocationOpenedContent } {
  const lineage = overrides.lineage;
  return {
    invocationId: overrides.invocationId ?? 'invocation-1',
    opening: {
      kind: 'invocation_opened',
      protocol: 'invocation_opened_v1',
      route: {
        provenance: 'unknown',
        backendKind: 'fake',
        llmConnectionSlug: 'fake',
        modelId: 'fake-model',
      },
      configuration: {
        cwd: '/workspace',
        permissionMode: 'ask',
        collaborationMode: 'agent',
        orchestrationMode: overrides.orchestrationMode ?? 'default',
        orchestrationSource: overrides.orchestrationSource ?? 'session',
        toolMode: 'direct',
        agentSwarmAuthorization: 'none',
      },
      root,
      source: overrides.source ?? { kind: 'fresh' },
      ...(lineage ? { lineage } : {}),
    },
  };
}

test('regenerate root identity requires exactly its own turn lineage', () => {
  const lineage = { parentTurnId: 'turn-1', regeneratedFromTurnId: 'turn-1' };
  const execution = { kind: 'regenerate', sourceTurnId: 'turn-1' } as const;

  assert.equal(
    invocationMatchesHostedRootExecution(invocation({ kind: 'user' }, { lineage }), execution),
    true,
  );
  assert.equal(
    invocationMatchesHostedRootExecution(
      invocation({ kind: 'user' }, { lineage: { ...lineage, regeneratedFromTurnId: 'turn-x' } }),
      execution,
    ),
    false,
  );
  // One extra lineage edge is one edge too many: a regenerate root has no parent
  // run, no agent and no branch.
  assert.equal(
    invocationMatchesHostedRootExecution(
      invocation({ kind: 'user' }, { lineage: { ...lineage, parentRunId: 'run-0' } }),
      execution,
    ),
    false,
  );
  assert.equal(
    invocationMatchesHostedRootExecution(
      invocation({ kind: 'scheduled_task', scheduledTaskId: 'task-1' }, { lineage }),
      execution,
    ),
    false,
  );
});

test('context compact root identity rejects any lineage and any other root', () => {
  const execution = { kind: 'context_compact' } as const;

  assert.equal(
    invocationMatchesHostedRootExecution(invocation({ kind: 'context_compact' }), execution),
    true,
  );
  assert.equal(
    invocationMatchesHostedRootExecution(invocation({ kind: 'user' }), execution),
    false,
  );
  assert.equal(
    invocationMatchesHostedRootExecution(
      invocation({ kind: 'context_compact' }, { lineage: { parentTurnId: 'turn-1' } }),
      execution,
    ),
    false,
  );
});

test('each host authority root matches only its own kind and id', () => {
  assert.equal(
    invocationMatchesHostedRootExecution(
      invocation({ kind: 'scheduled_task', scheduledTaskId: 'task-1' }),
      { kind: 'scheduled_task', scheduledTaskId: 'task-1' },
    ),
    true,
  );
  assert.equal(
    invocationMatchesHostedRootExecution(
      invocation({ kind: 'scheduled_task', scheduledTaskId: 'task-2' }),
      { kind: 'scheduled_task', scheduledTaskId: 'task-1' },
    ),
    false,
  );
  assert.equal(
    invocationMatchesHostedRootExecution(
      invocation({ kind: 'legacy_automation', legacyAutomationId: 'automation-1' }),
      { kind: 'legacy_automation', automationId: 'automation-1' },
    ),
    true,
  );
  assert.equal(
    invocationMatchesHostedRootExecution(invocation({ kind: 'goal', goalId: 'goal-1' }), {
      kind: 'goal',
      goalId: 'goal-1',
    }),
    true,
  );
  // A Goal root is not a ScheduledTask root, and the union says so directly.
  assert.equal(
    invocationMatchesHostedRootExecution(invocation({ kind: 'goal', goalId: 'goal-1' }), {
      kind: 'scheduled_task',
      scheduledTaskId: 'goal-1',
    }),
    false,
  );
});

test('a supervisor wake root carries its graph prefix and graph orchestration', () => {
  const root = {
    kind: 'agent_graph_supervisor_wake',
    wakeId: 'graph-1:wake-1',
    attemptId: 'attempt-1',
  } as const;
  const execution = {
    kind: 'agent_graph_supervisor_wake',
    graphId: 'graph-1',
    wakeId: 'graph-1:wake-1',
    attemptId: 'attempt-1',
  } as const;
  const graphConfiguration = {
    orchestrationMode: 'graph',
    orchestrationSource: 'turn_override',
  } as const;

  assert.equal(
    invocationMatchesHostedRootExecution(invocation(root, graphConfiguration), execution),
    true,
  );
  assert.equal(invocationMatchesHostedRootExecution(invocation(root), execution), false);
  assert.equal(
    invocationMatchesHostedRootExecution(invocation(root, graphConfiguration), {
      ...execution,
      graphId: 'graph-2',
    }),
    false,
  );
});

test('a safe boundary continuation root matches its claim and its own invocation', () => {
  const source = {
    kind: 'continuation',
    sourceInvocationId: 'invocation-0',
    sourceRunId: 'run-0',
    sourceTurnId: 'turn-0',
    sourceRuntimeEventHighWater: 4,
    claimId: 'claim-1',
    boundaryDigest: BOUNDARY_DIGEST,
  } as const;
  const lineage = { parentRunId: 'run-0', parentTurnId: 'turn-0' };
  const execution = {
    kind: 'safe_boundary_continuation',
    sourceInvocationId: 'invocation-0',
    sourceRunId: 'run-0',
    sourceTurnId: 'turn-0',
    sourceRuntimeEventHighWater: 4,
    claimId: 'claim-1',
    boundaryDigest: BOUNDARY_DIGEST,
    providerReplayDigest: BOUNDARY_DIGEST,
    safetyDigest: BOUNDARY_DIGEST,
    targetInvocationId: 'invocation-1',
  } as const;

  assert.equal(
    invocationMatchesHostedRootExecution(
      invocation({ kind: 'user' }, { source, lineage }),
      execution,
    ),
    true,
  );
  assert.equal(
    invocationMatchesHostedRootExecution(
      invocation({ kind: 'user' }, { source, lineage, invocationId: 'invocation-other' }),
      execution,
    ),
    false,
  );
  assert.equal(
    invocationMatchesHostedRootExecution(invocation({ kind: 'user' }, { lineage }), execution),
    false,
  );
});
