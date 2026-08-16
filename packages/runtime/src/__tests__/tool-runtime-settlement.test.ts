import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createBypassExecutionBoundary,
  createGenesisExecutionBoundary,
} from '@maka/core/sandbox-boundary';
import { type LlmConnection } from '@maka/core/llm-connections';
import { type SessionHeader } from '@maka/core/session';
import { buildForegroundBashTool, buildManagedBashTool } from '../shell-tools.js';
import { ToolRuntime, type MakaTool, type ToolRuntimeInput } from '../tool-runtime.js';

describe('ToolRuntime settlement', () => {
  it('requires the bypass boundary before dispatching Client Capability tools', async () => {
    let calls = 0;
    const clientTool: MakaTool = {
      name: 'client_browser',
      description: 'client browser',
      parameters: {},
      categoryHint: 'client_capability',
      impl: () => {
        calls += 1;
        return { ok: true };
      },
    };
    const settle = (runtime: ToolRuntime, toolCallId: string) =>
      runtime.settleToolCall({
        tool: clientTool,
        turnId: 'turn-1',
        stepId: 'step-1',
        toolCallId,
        input: {},
        abortSignal: new AbortController().signal,
        eventSink: {
          push: () => {},
          pushAndWaitUntilConsumed: async () => {},
        },
      });

    const blocked = await settle(
      makeRuntime({
        readExecutionBoundary: async () => createGenesisExecutionBoundary('ask'),
      }),
      'call-managed',
    );
    assert.equal(calls, 0);
    assert.match(
      String((blocked.result as { error?: unknown }).error),
      /require the Bypass execution boundary/,
    );

    const allowed = await settle(
      makeRuntime({
        readExecutionBoundary: async () => createBypassExecutionBoundary(0),
      }),
      'call-bypass',
    );
    assert.equal(calls, 1);
    assert.deepEqual(allowed.result, { ok: true });
  });

  it('keeps the durable Bash command while omitting it from the live model output', async () => {
    const runtime = makeRuntime();
    const bash = buildForegroundBashTool({
      description: 'shell',
      execute: async () => ({
        exitCode: 0,
        stdout: 'done',
        stderr: '',
        stdoutTruncated: true,
        stderrTruncated: false,
      }),
    });
    const settlement = await runtime.settleToolCall({
      tool: bash,
      turnId: 'turn-1',
      stepId: 'step-1',
      toolCallId: 'call-1',
      input: { command: 'printf durable-command' },
      abortSignal: new AbortController().signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
    });

    assert.equal((settlement.result as { cmd?: unknown }).cmd, 'printf durable-command');
    assert.deepEqual(settlement.modelOutput, {
      type: 'json',
      value: {
        kind: 'terminal',
        cwd: '/workspace/repo',
        status: 'completed',
        exitCode: 0,
        output: {
          mode: 'pipes',
          stdout: 'done',
          stderr: '',
          stdoutTruncated: true,
          stderrTruncated: false,
          redacted: false,
        },
      },
    });
  });

  it('projects every managed foreground Bash terminal state without its command', async () => {
    const terminalResults = [
      {
        kind: 'terminal' as const,
        cwd: '/workspace/repo',
        cmd: 'printf completed',
        status: 'completed' as const,
        exitCode: 0,
        output: {
          mode: 'pipes' as const,
          stdout: 'tail',
          stderr: '',
          stdoutTruncated: true,
          stderrTruncated: false,
          redacted: false,
        },
      },
      {
        kind: 'terminal' as const,
        cwd: '/workspace/repo',
        cmd: 'printf failed',
        status: 'failed' as const,
        exitCode: 2,
        output: {
          mode: 'pipes' as const,
          stdout: '',
          stderr: 'failed',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
        sandboxDenial: {
          likely: true as const,
          backend: 'macos-seatbelt' as const,
          recovery: 'require_escalated' as const,
        },
      },
      {
        kind: 'terminal' as const,
        cwd: '/workspace/repo',
        cmd: 'printf timed-out',
        status: 'timed_out' as const,
        exitCode: 124,
        output: {
          mode: 'pipes' as const,
          stdout: 'partial',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: false,
        },
      },
      {
        kind: 'terminal' as const,
        cwd: '/workspace/repo',
        cmd: 'printf cancelled',
        status: 'cancelled' as const,
        exitCode: 130,
        output: {
          mode: 'pipes' as const,
          stdout: '',
          stderr: 'cancelled',
          stdoutTruncated: false,
          stderrTruncated: false,
          redacted: true,
        },
      },
    ];

    for (const [index, terminal] of terminalResults.entries()) {
      const runtime = makeRuntime();
      const bash = buildManagedBashTool({
        runForegroundBash: async () => terminal,
        runBackgroundBash: async () => {
          throw new Error('not used');
        },
      });
      const settlement = await runtime.settleToolCall({
        tool: bash,
        turnId: 'turn-1',
        stepId: 'step-1',
        toolCallId: `call-${index}`,
        input: { command: terminal.cmd },
        abortSignal: new AbortController().signal,
        eventSink: {
          push: () => {},
          pushAndWaitUntilConsumed: async () => {},
        },
      });
      const { cmd: _cmd, ...projected } = terminal;

      assert.deepEqual(settlement.result, terminal);
      assert.deepEqual(settlement.modelOutput, { type: 'json', value: projected });
      assert.equal(terminalResults[index]?.cmd, terminal.cmd);
    }
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

  it('records apply_patch failures without changing their provider output shape', async () => {
    const events: Array<{ type: string; isError?: boolean }> = [];
    const runtime = makeRuntime();
    const settlement = await runtime.settleToolCall({
      tool: {
        ...tool(() => ({ error: 'dispatch failed' })),
        name: 'apply_patch',
        providerTool: { kind: 'openai-apply-patch' },
      },
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
    assert.deepEqual(settlement.modelOutput, {
      type: 'json',
      value: { status: 'failed', output: 'dispatch failed' },
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

  it('rejects direct-only nested tools before permission argument projection or implementation', async () => {
    let permissionProjectionCalls = 0;
    let implementationCalls = 0;
    const runtime = makeRuntime();

    const settlement = await runtime.settleToolCall({
      tool: {
        ...tool(() => {
          implementationCalls += 1;
          return { ok: true };
        }),
        nesting: 'direct_only',
        permissionArgs: (input) => {
          permissionProjectionCalls += 1;
          return input;
        },
      },
      turnId: 'turn-1',
      toolCallId: 'nested-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: () => {},
        pushAndWaitUntilConsumed: async () => {},
      },
      origin: 'code_mode',
      parentToolCallId: 'exec-1',
    });

    assert.equal(permissionProjectionCalls, 0);
    assert.equal(implementationCalls, 0);
    assert.deepEqual(settlement.modelOutput, {
      type: 'error-text',
      value: 'Error: Tool Read is direct-only and cannot run inside exec.',
    });
  });

  it('keeps permission projections for ordinary step-admission failures', async () => {
    const runtime = makeRuntime();
    const events: Array<{ type: string; args?: unknown }> = [];
    await runtime.settleToolCall({
      tool: {
        ...tool(() => ({ ok: true })),
        name: 'exclusive',
        executionSemantics: 'exclusive_step',
      },
      turnId: 'turn-1',
      stepId: 'step-1',
      toolCallId: 'exclusive-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: { push: () => {}, pushAndWaitUntilConsumed: async () => {} },
    });

    const settlement = await runtime.settleToolCall({
      tool: {
        ...tool(() => ({ ok: true })),
        permissionArgs: () => ({ safe: true }),
      },
      turnId: 'turn-1',
      stepId: 'step-1',
      toolCallId: 'rejected-1',
      input: { secret: 'must-not-persist' },
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => {
          events.push(event);
        },
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });

    assert.deepEqual(settlement.result, {
      error:
        'Tool Read did not run: exclusive cannot share an assistant step with other tool calls. Send Read again in a later step.',
    });
    assert.deepEqual(events[0]?.args, { safe: true });
  });

  it('publishes a live tool_result_preview when a linked child becomes ready', async () => {
    const events: Array<{ type: string; content?: unknown }> = [];
    const runtime = makeRuntime({
      runId: 'parent-run',
      spawnChildSession: async (input) => {
        await input.onReady?.({
          childSessionId: 'child-session',
          turnId: 'child-turn',
          runId: 'child-run',
          agentId: 'local_read',
          agentName: 'Local Read',
          permissionMode: 'explore',
        });
        return {
          kind: 'subagent',
          childSessionId: 'child-session',
          agentId: 'local_read',
          agentName: 'Local Read',
          turnId: 'child-turn',
          runId: 'child-run',
          status: 'completed',
          permissionMode: 'explore',
          summary: 'done',
          artifactIds: [],
        };
      },
    });

    const settlement = await runtime.settleToolCall({
      tool: {
        name: 'agent_spawn',
        description: 'spawn',
        parameters: {},
        impl: async (_args, ctx) => {
          assert.equal(typeof ctx.spawnChildSession, 'function');
          return await ctx.spawnChildSession!({
            agentProfile: 'local_read',
            prompt: 'Inspect',
          });
        },
      },
      turnId: 'turn-1',
      stepId: 'step-1',
      toolCallId: 'spawn-1',
      input: {},
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });

    const preview = events.find((event) => event.type === 'tool_result_preview');
    assert.deepEqual(preview?.content, {
      kind: 'subagent',
      childSessionId: 'child-session',
      agentId: 'local_read',
      agentName: 'Local Read',
      turnId: 'child-turn',
      runId: 'child-run',
      status: 'running',
      permissionMode: 'explore',
    });
    const previewIndex = events.findIndex((event) => event.type === 'tool_result_preview');
    const resultIndex = events.findIndex((event) => event.type === 'tool_result');
    assert.ok(resultIndex > previewIndex);
    assert.equal(
      (settlement.result as { childSessionId?: string }).childSessionId,
      'child-session',
    );
  });
});

function makeRuntime(
  overrides: Partial<
    Pick<
      ToolRuntimeInput,
      'materializeDefaultToolResultOutput' | 'readExecutionBoundary' | 'spawnChildSession' | 'runId'
    >
  > = {},
): ToolRuntime {
  return createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'model-1',
    appendMessage: async () => {},
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
