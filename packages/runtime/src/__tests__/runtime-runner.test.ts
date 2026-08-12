import { describe, test } from 'node:test';
import { expect } from '../test-helpers.js';
import {
  RuntimeRunner,
  buildInitialUserRuntimeEvent,
  runtimeGateFromCallback,
  type RuntimeGate,
} from '../runtime-runner.js';
import type {
  InvocationContext,
  InvocationProviders,
  InvocationRequest,
} from '../invocation-context.js';
import type { RuntimeEvent, RuntimeEventStatus } from '@maka/core/runtime-event';
import type { FlowInput, RunnableAgentFlow } from '../agent-flow.js';

// ============================================================================
// Test fakes / helpers
// ============================================================================

/** Deterministic providers so event ids and timestamps are predictable. */
function makeProviders(): InvocationProviders & { count: () => number } {
  let n = 0;
  return {
    newId: () => `id-${(n += 1)}`,
    now: () => 1000 + n,
    count: () => n,
  };
}

function makeRequest(overrides: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    text: 'hi',
    source: 'test',
    ...overrides,
  };
}

/**
 * Fake flow that runs a script to produce its events. The script receives
 * the InvocationContext so events can line up with the invocation spine.
 */
class ScriptFlow implements RunnableAgentFlow {
  readonly seen: InvocationContext[] = [];
  readonly seenInputs: FlowInput[] = [];
  constructor(
    private readonly script: (ctx: InvocationContext) => RuntimeEvent[] | Promise<RuntimeEvent[]>,
  ) {}

  async *run(ctx: InvocationContext, input: FlowInput): AsyncIterable<RuntimeEvent> {
    this.seen.push(ctx);
    this.seenInputs.push(input);
    for (const ev of await this.script(ctx)) {
      yield ev;
    }
  }
}

/** Flow that throws on first iteration. */
class ThrowingFlow implements RunnableAgentFlow {
  ran = false;
  constructor(private readonly error: unknown) {}
  async *run(): AsyncIterable<RuntimeEvent> {
    this.ran = true;
    throw this.error;
  }
}

function flowTextEvent(ctx: InvocationContext, text: string): RuntimeEvent {
  return {
    id: ctx.newId(),
    invocationId: ctx.invocationId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    ts: ctx.now(),
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'text', text },
  };
}

function flowTerminalEvent(ctx: InvocationContext, status: RuntimeEventStatus): RuntimeEvent {
  return {
    id: ctx.newId(),
    invocationId: ctx.invocationId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    ts: ctx.now(),
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    partial: false,
    role: 'model',
    author: 'agent',
    status,
    actions: { endInvocation: true },
  };
}

function flowErrorEvent(ctx: InvocationContext, message: string): RuntimeEvent {
  return {
    id: ctx.newId(),
    invocationId: ctx.invocationId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    ts: ctx.now(),
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    partial: false,
    role: 'system',
    author: 'system',
    content: { kind: 'error', reason: 'tool_failed', message },
  };
}

function flowTokenUsageEvent(ctx: InvocationContext, rawFinishReason: string): RuntimeEvent {
  return {
    id: ctx.newId(),
    invocationId: ctx.invocationId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    ts: ctx.now(),
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    partial: false,
    role: 'system',
    author: 'system',
    actions: { tokenUsage: { input: 1, output: 1, rawFinishReason } },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('RuntimeRunner', () => {
  test('preflight failure returns no flow events and does not call the flow', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow(() => [flowTextEvent({} as never, 'should-not-happen')]);
    const gate: RuntimeGate = {
      preflight: async () => ({ ok: false, reason: 'session_blocked' }),
    };
    const runner = new RuntimeRunner({ flow, gate, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.events).toEqual([]);
    expect(flow.seen).toEqual([]);
    expect(result.failure?.class).toBe('preflight');
    expect(result.failure?.message).toBe('session_blocked');
    expect(result.startedAt <= result.finishedAt).toBe(true);
  });

  test('initial event declares the tool boundary protocol only when the durable boundary is active', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [flowTerminalEvent(ctx, 'completed')]);
    const deps = {
      flow,
      providers,
      toolBoundaryProtocol: 't1_after_preflight_v1' as const,
    };
    const runner = new RuntimeRunner(deps);

    const result = await runner.run(makeRequest());

    expect(result.events[0]?.actions?.runtimeProtocol).toEqual({
      toolBoundary: 't1_after_preflight_v1',
    });
  });

  test('a flow that exhausts without a terminal event maps to a failed result', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [flowTextEvent(ctx, 'hello')]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('missing_terminal_event');
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.author).toBe('user');
    expect(result.events[1]!.author).toBe('agent');
  });

  test('uses the last non-partial non-empty model text as finalOutput', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [
      flowTextEvent(ctx, 'first answer'),
      { ...flowTextEvent(ctx, 'streaming draft'), partial: true },
      flowTextEvent(ctx, '   '),
      flowTextEvent(ctx, 'final answer'),
      flowTerminalEvent(ctx, 'completed'),
    ]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('completed');
    expect(result.finalOutput).toBe('final answer');
  });

  test('completed terminal without non-empty model text fails as missing_final_output', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [
      flowTextEvent(ctx, '   '),
      flowTerminalEvent(ctx, 'completed'),
    ]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.finalOutput).toBeUndefined();
    expect(result.failure?.class).toBe('missing_final_output');
  });

  test('stopOnTerminal false keeps draining and fails on any non-completed terminal event', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [
      flowTerminalEvent(ctx, 'completed'),
      flowTextEvent(ctx, 'cleanup-after-completed'),
      flowTerminalEvent(ctx, 'aborted'),
      flowTextEvent(ctx, 'cleanup-after-aborted'),
    ]);
    const runner = new RuntimeRunner({ flow, providers, stopOnTerminal: false });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('aborted');
    expect(result.failure?.terminalStatus).toBe('aborted');
    expect(result.events).toHaveLength(5);
    expect(
      result.events.some(
        (ev) => ev.content?.kind === 'text' && ev.content.text === 'cleanup-after-completed',
      ),
    ).toBe(true);
    expect(
      result.events.some(
        (ev) => ev.content?.kind === 'text' && ev.content.text === 'cleanup-after-aborted',
      ),
    ).toBe(true);
  });

  test('non-terminal error content cannot be masked by a completed terminal event', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [
      flowErrorEvent(ctx, 'Operation failed'),
      flowTerminalEvent(ctx, 'completed'),
    ]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('tool_failed');
    expect(result.failure?.message).toBe('Operation failed');
    expect(result.events.at(-1)?.status).toBe('completed');
  });

  test('raw tool-calls finish reason marks a completed terminal event as a tool step cap', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [
      flowTokenUsageEvent(ctx, 'tool-calls'),
      flowTerminalEvent(ctx, 'completed'),
    ]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('tool_step_cap_reached');
    expect(result.failure?.message).toMatch(/tool-call step cap/);
  });

  test('graph yield completes without final text or a false tool step cap', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [
      flowTokenUsageEvent(ctx, 'tool-calls'),
      {
        ...flowTerminalEvent(ctx, 'completed'),
        actions: {
          endInvocation: true,
          stateDelta: { stopReason: 'graph_yield' },
        },
      },
    ]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('completed');
    expect(result.finalOutput).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });

  test('graph yield does not hide a real preceding runtime error', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [
      flowErrorEvent(ctx, 'Operation failed'),
      flowTokenUsageEvent(ctx, 'tool-calls'),
      {
        ...flowTerminalEvent(ctx, 'completed'),
        actions: {
          endInvocation: true,
          stateDelta: { stopReason: 'graph_yield' },
        },
      },
    ]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('tool_failed');
  });

  test('a flow that throws maps to a failed result (user event retained)', async () => {
    const providers = makeProviders();
    const flow = new ThrowingFlow(new Error('boom'));
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('Error');
    expect(result.failure?.message).toBe('boom');
    expect(flow.ran).toBe(true);
    // The user event was collected before the flow threw.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.author).toBe('user');
  });

  test('a flow emitting an aborted terminal event maps to a failed result', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [flowTerminalEvent(ctx, 'aborted')]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('aborted');
    expect(result.failure?.terminalStatus).toBe('aborted');
  });

  test('a flow emitting a failed terminal event surfaces error content as failure message', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [
      {
        ...flowTerminalEvent(ctx, 'failed'),
        content: { kind: 'error', message: 'provider 500' },
      },
    ]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    // No reason/code on the error content → classifies as runtime_error
    // (not the bare 'failed'), message still surfaces.
    expect(result.failure?.class).toBe('runtime_error');
    expect(result.failure?.message).toBe('provider 500');
    expect(result.failure?.terminalStatus).toBe('failed');
  });

  test('a failed terminal event with a reason code uses that code as the class', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [
      {
        ...flowTerminalEvent(ctx, 'failed'),
        content: { kind: 'error', reason: 'tool_failed', message: 'Tool execution failed' },
      },
    ]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('tool_failed');
    expect(result.failure?.message).toBe('Tool execution failed');
    expect(result.failure?.terminalStatus).toBe('failed');
  });

  test('a failed terminal event with no error content classifies as runtime_error not failed', async () => {
    // Reproduces complete(stopReason=error) with no preceding error event:
    // the terminal RuntimeEvent has status='failed' but no error content.
    // Previously this returned class='failed', indistinguishable from other
    // failures; now it returns 'runtime_error' so benchmark scoring can
    // distinguish runtime failures from max_tokens / tool_step_cap_reached.
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [flowTerminalEvent(ctx, 'failed')]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('runtime_error');
    expect(result.failure?.terminalStatus).toBe('failed');
  });

  test('a failed terminal event preserves its state-delta failure class', async () => {
    const providers = makeProviders();
    const flow = new ScriptFlow((ctx) => [
      {
        ...flowTerminalEvent(ctx, 'failed'),
        actions: {
          endInvocation: true,
          stateDelta: { stopReason: 'step_limit', failureClass: 'tool_step_cap_reached' },
        },
      },
    ]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest());

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('tool_step_cap_reached');
    expect(result.failure?.terminalStatus).toBe('failed');
  });

  test('already-aborted signal before dispatch yields a failed result without flow dispatch', async () => {
    const providers = makeProviders();
    const ac = new AbortController();
    ac.abort();
    const flow = new ScriptFlow((ctx) => [flowTextEvent(ctx, 'nope')]);
    const runner = new RuntimeRunner({ flow, providers });

    const result = await runner.run(makeRequest({ abortSignal: ac.signal }));

    expect(result.status).toBe('failed');
    expect(result.failure?.class).toBe('aborted');
    expect(result.events).toEqual([]);
    expect(flow.seen).toEqual([]);
  });
});
