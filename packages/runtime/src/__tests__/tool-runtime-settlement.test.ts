import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmConnection, SessionHeader } from '@maka/core';
import { PermissionEngine } from '../permission-engine.js';
import { ToolRuntime, type MakaTool, type ToolRuntimeInput } from '../tool-runtime.js';

describe('ToolRuntime settlement', () => {
  it('returns the raw result and provider-facing model output', async () => {
    const runtime = makeRuntime();
    const result = { ok: true, value: 42 };

    const settlement = await runtime.settleToolCall({
      tool: tool(() => result),
      turnId: 'turn-1',
      stepId: 'step-1',
      toolCallId: 'call-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
    });

    assert.deepEqual(settlement, {
      result,
      modelOutput: { type: 'json', value: result },
    });
  });

  it('preserves live provider error mapping', async () => {
    const runtime = makeRuntime();
    const result = {
      error: 'internal detail',
      text: 'tool text',
      modelText: 'safe model detail',
    };

    const settlement = await runtime.settleToolCall({
      tool: {
        ...tool(() => result),
        toModelOutput: () => ({
          type: 'content',
          value: [{ type: 'text', text: 'must not be used' }],
        }),
      },
      turnId: 'turn-1',
      stepId: 'step-1',
      toolCallId: 'call-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
    });

    assert.deepEqual(settlement, {
      result,
      modelOutput: { type: 'error-text', value: 'Error: safe model detail' },
    });
  });

  it('falls back from provider text to the raw error message', async () => {
    const runtime = makeRuntime();
    for (const [result, expected] of [
      [{ error: 'internal detail', text: 'tool text' }, 'Error: tool text'],
      [{ error: 'internal detail' }, 'Error: internal detail'],
    ] as const) {
      const settlement = await runtime.settleToolCall({
        tool: tool(() => result),
        turnId: 'turn-1',
        stepId: 'step-1',
        toolCallId: `call-${expected}`,
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: {
          push: () => {},
          pushAndWaitUntilConsumed: async () => {},
        },
      });

      assert.deepEqual(settlement.modelOutput, { type: 'error-text', value: expected });
    }
  });

  it('keeps structured durable failures on the live success arm', async () => {
    const runtime = makeRuntime();
    const events: Array<{ type: string; isError?: boolean }> = [];
    const result = {
      kind: 'subagent',
      agentName: 'Reviewer',
      turnId: 'child-turn',
      status: 'failed',
      permissionMode: 'explore',
      summary: 'review failed',
      artifactIds: [],
    };

    const settlement = await runtime.settleToolCall({
      tool: tool(() => result),
      turnId: 'turn-1',
      stepId: 'step-1',
      toolCallId: 'call-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });

    assert.equal(
      events.some((event) => event.type === 'tool_result' && event.isError === true),
      true,
    );
    assert.deepEqual(settlement.modelOutput, { type: 'json', value: result });
  });

  it('uses the runtime model-output materializer for default tool results', async () => {
    const result = { kind: 'image', ref: 'artifact-1' };
    const runtime = makeRuntime({
      materializeDefaultToolResultOutput: async ({ toolCallId, output }) => {
        assert.equal(toolCallId, 'call-1');
        assert.equal(output, result);
        return { type: 'text', value: 'materialized image' };
      },
    });

    const settlement = await runtime.settleToolCall({
      tool: tool(() => result),
      turnId: 'turn-1',
      stepId: 'step-1',
      toolCallId: 'call-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
    });

    assert.deepEqual(settlement.modelOutput, { type: 'text', value: 'materialized image' });
  });

  it('registers step admission synchronously before settlement awaits', async () => {
    const runtime = makeRuntime();
    const pending = runtime.settleToolCall({
      tool: tool(() => ({ ok: true })),
      turnId: 'turn-1',
      stepId: 'step-1',
      toolCallId: 'call-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
    });

    await pending;
  });
});

function makeRuntime(
  overrides: Pick<ToolRuntimeInput, 'materializeDefaultToolResultOutput'> = {},
): ToolRuntime {
  const permissionEngine = new PermissionEngine({ newId: nextId(), now: () => 1 });
  permissionEngine.beginTurn('turn-1');
  return new ToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'model-1',
    appendMessage: async () => {},
    permissionEngine,
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    ...overrides,
  });
}

function tool(impl: MakaTool['impl']): MakaTool {
  return {
    name: 'Read',
    description: 'read',
    parameters: {},
    permissionRequired: false,
    impl,
  };
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/repo',
    cwd: '/workspace/repo',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'connection-1',
    connectionLocked: true,
    model: 'model-1',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'connection-1',
    name: 'test',
    providerType: 'openai',
    defaultModel: 'model-1',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function nextId(): () => string {
  let value = 0;
  return () => `id-${++value}`;
}
