import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import type {
  EffectiveOrchestration,
  SessionEvent,
  SessionHeader,
  StoredMessage,
  ToolPermissionRule,
} from '@maka/core';

import { PermissionEngine } from '../permission-engine.js';
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
  options: Pick<MakaTool, 'executionSemantics' | 'permissionRequired' | 'categoryHint'> = {},
): MakaTool {
  return {
    name,
    description: name,
    parameters: z.object({}),
    permissionRequired: options.permissionRequired ?? false,
    ...(options.executionSemantics ? { executionSemantics: options.executionSemantics } : {}),
    ...(options.categoryHint ? { categoryHint: options.categoryHint } : {}),
    impl: () => {
      calls.push(name);
      return { ok: true };
    },
  };
}

function harness(
  input: {
    orchestration?: EffectiveOrchestration;
    permissionRules?: readonly ToolPermissionRule[];
  } = {},
) {
  const appended: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const calls: string[] = [];
  const engine = new PermissionEngine({ newId: () => 'permission-1', now: () => 1 });
  let stepId = 'step-1';
  let id = 0;
  const runtime = new ToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: { providerType: 'openai', slug: 'c' } as never,
    modelId: 'm',
    appendMessage: async (message) => {
      appended.push(message);
    },
    permissionEngine: engine,
    newId: () => `id-${++id}`,
    now: () => 1,
    getPermissionPauseTarget: () => null,
    getCurrentOrchestration: () => input.orchestration,
    ...(input.permissionRules ? { permissionRules: input.permissionRules } : {}),
  });
  engine.beginTurn('turn-1');
  runtime.beginTurn('turn-1');
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

describe('Swarm orchestration authorization', () => {
  const swarm: EffectiveOrchestration = {
    mode: 'swarm',
    source: 'turn_override',
    agentSwarmAuthorization: 'turn_override',
  };

  test('the trusted envelope allows exactly agent_swarm without prompting', async () => {
    const fixture = harness({ orchestration: swarm });
    const result = await invoke(
      fixture,
      tool('agent_swarm', fixture.calls, {
        executionSemantics: 'exclusive_step',
        permissionRequired: true,
        categoryHint: 'subagent',
      }),
    );
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(fixture.calls, ['agent_swarm']);
    assert.equal(
      fixture.events.some((event) => event.type === 'permission_request'),
      false,
    );
  });

  test('an explicit deny still wins over Swarm Mode authorization', async () => {
    const fixture = harness({
      orchestration: swarm,
      permissionRules: [{ effect: 'deny', kind: 'tool', toolName: 'agent_swarm' }],
    });
    const result = await invoke(
      fixture,
      tool('agent_swarm', fixture.calls, {
        executionSemantics: 'exclusive_step',
        permissionRequired: true,
        categoryHint: 'subagent',
      }),
    );
    assert.deepEqual(fixture.calls, []);
    assert.match(JSON.stringify(result), /denied|blocked|not allowed/i);
  });

  test('the Swarm envelope does not widen unrelated tool permissions', async () => {
    const fixture = harness({
      orchestration: swarm,
      permissionRules: [{ effect: 'deny', kind: 'tool', toolName: 'Write' }],
    });
    await invoke(
      fixture,
      tool('Write', fixture.calls, { permissionRequired: true, categoryHint: 'file_write' }),
    );
    assert.deepEqual(fixture.calls, []);
  });
});
