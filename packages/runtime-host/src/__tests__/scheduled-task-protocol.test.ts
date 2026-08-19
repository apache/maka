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
import { decodeScheduledTask, decodeScheduledTaskMutateInput } from '../protocol/scheduled-task.js';

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

  test('a retired backend decodes on the way out but not on the way in', () => {
    // #3211: the same execution decoder serves both directions, and they carry
    // different backend invariants. A stored Automation frozen by a build that
    // shipped FakeBackend must stay readable; a live create/update may not
    // introduce the retired value.
    const retired = (effect: ScheduledTaskEffect): ScheduledTaskEffect =>
      effect.kind === 'agent_run'
        ? { ...effect, execution: { ...effect.execution, backend: 'fake' } }
        : effect;

    const stored = { ...scheduledTask('task-1'), effect: retired(agentRunEffect('project-1')) };
    assert.equal(decodeScheduledTask(stored).effect.kind, 'agent_run');

    for (const input of [
      {
        kind: 'create' as const,
        input: {
          title: 'Inspect workspace',
          intentBody: 'Summarize the workspace.',
          schedule: { kind: 'once' as const, runAt: 1 },
          effect: retired(agentRunEffect('project-1')),
        },
      },
      {
        kind: 'update' as const,
        taskId: 'task-1',
        patch: { effect: retired(agentRunEffect('project-1')) },
      },
    ]) {
      assert.throws(() => decodeScheduledTaskMutateInput(input), /Invalid ScheduledTask backend/);
    }
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
      backend: 'ai-sdk',
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
