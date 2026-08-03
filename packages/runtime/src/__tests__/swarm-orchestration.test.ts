import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import type { SessionEvent, SessionHeader, StoredMessage } from '@maka/core';

import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'c',
    connectionLocked: true,
    model: 'm',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function tool(
  name: string,
  calls: string[],
  options: Pick<MakaTool, 'executionSemantics' | 'categoryHint'> = {},
): MakaTool {
  return {
    name,
    description: name,
    parameters: z.object({}),
    ...(options.executionSemantics ? { executionSemantics: options.executionSemantics } : {}),
    ...(options.categoryHint ? { categoryHint: options.categoryHint } : {}),
    impl: () => {
      calls.push(name);
      return { ok: true };
    },
  };
}

function harness() {
  const appended: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const calls: string[] = [];
  let stepId = 'step-1';
  let id = 0;
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: { providerType: 'openai', slug: 'c' } as never,
    modelId: 'm',
    appendMessage: async (message) => {
      appended.push(message);
    },
    newId: () => `id-${++id}`,
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
  return {
    runtime,
    calls,
    events,
    currentStepId: () => stepId,
    setStepId: (next: string) => {
      stepId = next;
    },
  };
}

let toolCallSequence = 0;
async function invoke(fixture: ReturnType<typeof harness>, value: MakaTool): Promise<unknown> {
  return (
    await fixture.runtime.settleToolCall({
      tool: value,
      turnId: 'turn-1',
      stepId: fixture.currentStepId(),
      toolCallId: `tool-call-${++toolCallSequence}`,
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => fixture.events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          fixture.events.push(event);
        },
      },
    })
  ).result;
}

describe('Swarm orchestration admission', () => {
  test('an exclusive tool cannot follow or precede another tool in the same step', async () => {
    const first = harness();
    const ordinary = tool('Read', first.calls);
    const exclusive = tool('agent_swarm', first.calls, { executionSemantics: 'exclusive_step' });
    await invoke(first, ordinary);
    const rejectedExclusive = await invoke(first, exclusive);
    assert.deepEqual(first.calls, ['Read']);
    assert.match(JSON.stringify(rejectedExclusive), /cannot share an assistant step/);

    const second = harness();
    const exclusiveFirst = tool('agent_swarm', second.calls, {
      executionSemantics: 'exclusive_step',
    });
    const ordinarySecond = tool('Read', second.calls);
    await invoke(second, exclusiveFirst);
    const rejectedOrdinary = await invoke(second, ordinarySecond);
    assert.deepEqual(second.calls, ['agent_swarm']);
    assert.match(JSON.stringify(rejectedOrdinary), /exclusive tool agent_swarm/i);
  });

  test('exclusive admission is scoped to one assistant step', async () => {
    const fixture = harness();
    await invoke(
      fixture,
      tool('agent_swarm', fixture.calls, { executionSemantics: 'exclusive_step' }),
    );
    fixture.setStepId('step-2');
    await invoke(fixture, tool('Read', fixture.calls));
    assert.deepEqual(fixture.calls, ['agent_swarm', 'Read']);
  });
});
