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
import type { ScheduledTask, ScheduledTaskEffect } from '@maka/core/scheduled-task';
import {
  decodeScheduledTaskQueryResult,
  decodeHostFrame,
  REMOTE_OWNER_OPERATION_GRANTS,
  SCHEDULED_TASK_PAGE_MAX_ITEMS,
  type RequestFrame,
} from '../protocol/index.js';
import {
  authorizeRuntimeHostOperation,
  createRuntimeHostConnectionAuthority,
} from '../server/connection-authority.js';
import { decodeScheduledTaskMutateInput } from '../protocol/scheduled-task.js';

describe('ScheduledTask protocol', () => {
  test('requires Host-path authority only when a mutation submits a Host path', () => {
    const authority = createRuntimeHostConnectionAuthority({
      principalKind: 'remote_owner',
      principalId: 'remote-client',
      credentialId: 'remote-credential',
      operationGrants: REMOTE_OWNER_OPERATION_GRANTS,
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    });

    for (const frame of [createMutationFrame('project-1'), updateMutationFrame('project-1')]) {
      assert.equal(authorizeRuntimeHostOperation(authority, frame), true);
    }
    for (const projectId of [undefined, null, '']) {
      for (const frame of [createMutationFrame(projectId), updateMutationFrame(projectId)]) {
        assert.equal(authorizeRuntimeHostOperation(authority, frame), false);
      }
    }
  });

  test('a backend key from an older build is tolerated and dropped, both directions', () => {
    // #3306: `backend` left the template, but Automations frozen by older
    // builds still carry it — including the retired `'fake'` (#3211). The
    // execution decoder is a closed shape, so the key must stay tolerated on
    // the way in while never landing on the decoded value.
    const withRetiredBackend = (effect: ScheduledTaskEffect): unknown =>
      effect.kind === 'agent_run'
        ? { ...effect, execution: { ...effect.execution, backend: 'fake' } }
        : effect;
    const template = agentRunEffect('project-1');
    const expectedExecution = template.kind === 'agent_run' ? template.execution : assert.fail();
    const assertDropped = (effect: ScheduledTaskEffect | undefined) => {
      assert.equal(effect?.kind, 'agent_run');
      if (effect?.kind !== 'agent_run') return;
      assert.deepEqual(effect.execution, expectedExecution);
    };

    // Stored direction, through the full query-result frame.
    const fetched = decodeScheduledTaskQueryResult({
      kind: 'task',
      task: { ...scheduledTask('task-1'), effect: withRetiredBackend(template) },
    });
    assertDropped(fetched.kind === 'task' ? fetched.task?.effect : undefined);

    const created = decodeScheduledTaskMutateInput({
      kind: 'create',
      input: {
        title: 'Inspect workspace',
        intentBody: 'Summarize the workspace.',
        schedule: { kind: 'once', runAt: 1 },
        effect: withRetiredBackend(template),
      },
    });
    assertDropped(created.kind === 'create' ? created.input.effect : undefined);

    const updated = decodeScheduledTaskMutateInput({
      kind: 'update',
      taskId: 'task-1',
      patch: { effect: withRetiredBackend(template) },
    });
    assertDropped(updated.kind === 'update' ? updated.patch.effect : undefined);
  });

  test('accepts signal-only catalog changes', () => {
    const frame = {
      kind: 'scheduled-task.changed' as const,
      revision: 3,
      reason: 'fired' as const,
      taskId: 'task-1',
    };
    assert.deepEqual(decodeHostFrame(frame), frame);
    assert.throws(() => decodeHostFrame({ ...frame, runtimePayload: { secret: true } }));
  });

  test('bounds catalog pages by item count and encoded bytes', () => {
    const tasks = Array.from({ length: SCHEDULED_TASK_PAGE_MAX_ITEMS }, (_, index) =>
      scheduledTask(`task-${index}`),
    );
    const page = { kind: 'page' as const, revision: 1, tasks, nextCursor: null };
    assert.equal(decodeScheduledTaskQueryResult(page).kind, 'page');
    assert.throws(
      () =>
        decodeScheduledTaskQueryResult({
          ...page,
          tasks: [...tasks, scheduledTask('task-overflow')],
        }),
      /item limit/,
    );
    assert.throws(
      () =>
        decodeScheduledTaskQueryResult({
          ...page,
          tasks: Array.from({ length: 12 }, (_, index) =>
            scheduledTask(`large-${index}`, '"'.repeat(8_000)),
          ),
        }),
      /byte limit/,
    );
  });
});

function createMutationFrame(projectId: string | null | undefined): RequestFrame {
  return {
    requestId: 'request-1',
    operation: 'scheduled-task.mutate',
    input: {
      kind: 'create',
      input: {
        title: 'Inspect workspace',
        intentBody: 'Summarize the workspace.',
        schedule: { kind: 'once', runAt: 1 },
        effect: agentRunEffect(projectId),
      },
    },
  };
}

function updateMutationFrame(projectId: string | null | undefined): RequestFrame {
  return {
    requestId: 'request-2',
    operation: 'scheduled-task.mutate',
    input: {
      kind: 'update',
      taskId: 'task-1',
      patch: { effect: agentRunEffect(projectId) },
    },
  };
}

function agentRunEffect(projectId: string | null | undefined): ScheduledTaskEffect {
  return {
    kind: 'agent_run',
    execution: {
      cwd: '/workspace',
      ...(projectId === undefined ? {} : { projectId }),
      llmConnectionSlug: 'openai',
      model: 'gpt-5',
      permissionMode: 'ask',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
    },
  };
}

function scheduledTask(id: string, intentBody = ''): ScheduledTask {
  return {
    id,
    title: id,
    intent: { kind: 'text', body: intentBody },
    schedule: { kind: 'once', runAt: 1 },
    effect: { kind: 'notify', channel: 'local' },
    status: 'active',
    nextFireAt: 1,
    lastFireAt: null,
    fireCount: 0,
    maxFires: null,
    expiresAt: null,
    createdBy: { kind: 'user' },
    createdAt: 1,
    updatedAt: 1,
    runs: [],
    lastError: null,
  };
}
