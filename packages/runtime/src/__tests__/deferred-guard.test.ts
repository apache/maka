import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader } from '@maka/core/session';
import type { StoredMessage } from '@maka/core/session';
import { projectToolActivityArgs } from '@maka/core/tool-activity-args';

import { ToolRuntime, formatDeferredNotLoadedText, type MakaTool } from '../tool-runtime.js';
import { mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';

// The execute-boundary guard rejects a *gated* tool whose name is absent from
// the current step's active snapshot before the real impl.

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

interface Harness {
  runtime: ToolRuntime;
  appended: StoredMessage[];
  pushed: SessionEvent[];
  invocationArgsSummaries: string[];
}

function makeHarness(): Harness {
  const appended: StoredMessage[] = [];
  const pushed: SessionEvent[] = [];
  const invocationArgsSummaries: string[] = [];
  let n = 0;
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: { providerType: 'openai', slug: 'c' } as never,
    modelId: 'm',
    appendMessage: async (m) => {
      appended.push(m);
    },
    newId: () => `id-${++n}`,
    now: () => 1,
    getPermissionPauseTarget: () => null,
    recordToolInvocation: (record) => {
      invocationArgsSummaries.push(record.argsSummary ?? '');
    },
  });
  return { runtime, appended, pushed, invocationArgsSummaries };
}

function tool(name: string, implCalls: string[]): MakaTool {
  return {
    name,
    description: name,
    parameters: z.object({}),
    impl: () => {
      implCalls.push(name);
      return { ok: true };
    },
  };
}

function run(h: Harness, t: MakaTool, args: unknown = {}) {
  return h.runtime
    .settleToolCall({
      tool: t,
      turnId: 'turn-1',
      toolCallId: 'tc1',
      input: args,
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => h.pushed.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          h.pushed.push(event);
        },
      },
    })
    .then((settlement) => settlement.result);
}

describe('tool-availability execute-boundary guard', () => {
  test('projects a declared activity kind into persisted and live tool facts', async () => {
    const h = makeHarness();
    const implCalls: string[] = [];
    const t = Object.assign(tool('CustomCommand', implCalls), {
      activityKind: 'command' as const,
    });

    await run(h, t);

    const call = h.appended.find((message) => message.type === 'tool_call') as unknown as {
      activityKind?: string;
    };
    const start = h.pushed.find((event) => event.type === 'tool_start') as unknown as {
      activityKind?: string;
    };
    assert.equal(call.activityKind, 'command');
    assert.equal(start.activityKind, 'command');
  });

  test('keeps WriteStdin args exact across canonical ledgers and projects telemetry', async () => {
    const h = makeHarness();
    const implCalls: string[] = [];
    const t = tool('WriteStdin', implCalls);
    const args = {
      ref: 'maka://runtime/background-tasks/pty-1',
      input: 'password=ordinary-audited-input\r',
      size: { cols: 100, rows: 30 },
    };

    await run(h, t, args);

    const call = h.appended.find((message) => message.type === 'tool_call');
    const start = h.pushed.find(
      (event): event is Extract<SessionEvent, { type: 'tool_start' }> =>
        event.type === 'tool_start',
    );
    assert.ok(call?.type === 'tool_call');
    assert.ok(start);
    assert.deepEqual(call.args, args);
    assert.deepEqual(start.args, args);

    const runtimeEvent = mapSessionEventToRuntimeEvent(start, {
      sessionId: 'session-1',
      invocationId: 'inv-1',
      runId: 'run-1',
      turnId: 'turn-1',
      source: 'test',
      startedAt: 1,
      request: {
        sessionId: 'session-1',
        invocationId: 'inv-1',
        runId: 'run-1',
        turnId: 'turn-1',
        text: 'test',
        source: 'test',
      },
      newId: () => 'runtime-event-1',
      now: () => 1,
    });
    assert.equal(runtimeEvent.content?.kind, 'function_call');
    assert.deepEqual(
      runtimeEvent.content?.kind === 'function_call' ? runtimeEvent.content.args : undefined,
      args,
    );
    assert.deepEqual(
      JSON.parse(h.invocationArgsSummaries[0] ?? 'null'),
      projectToolActivityArgs('WriteStdin', args),
    );
  });

  test('rejects a gated tool absent from the step snapshot before implementation', async () => {
    const h = makeHarness();
    const implCalls: string[] = [];
    // The same-step trap: the browser group was just requested via load_tools
    // but is not yet active this step, so browser_click must be rejected.
    h.runtime.setGating({
      gatedNames: new Set(['browser_click']),
      activeNames: () => new Set(['Read', 'load_tools']),
    });

    const result = await run(h, tool('browser_click', implCalls));

    assert.deepEqual(implCalls, [], 'the real impl must not run');
    assert.deepEqual(result, { error: formatDeferredNotLoadedText('browser_click') });

    const callMsg = h.appended.find((m) => m.type === 'tool_call');
    const resultMsg = h.appended.find((m) => m.type === 'tool_result');
    assert.ok(callMsg, 'a ToolCallMessage is still written (call/result pairing intact)');
    assert.ok(resultMsg && resultMsg.isError, 'a synthetic error ToolResult is written');
    assert.ok(
      h.pushed.some((e) => e.type === 'tool_result' && e.isError && e.toolUseId === 'tc1'),
      'an error tool_result event is emitted to the renderer',
    );
  });

  test('lets a gated tool run once its name is in the step snapshot', async () => {
    const h = makeHarness();
    const implCalls: string[] = [];
    h.runtime.setGating({
      gatedNames: new Set(['browser_click']),
      activeNames: () => new Set(['Read', 'load_tools', 'browser_click']),
    });

    const t = tool('browser_click', implCalls);
    await run(h, t);

    assert.deepEqual(implCalls, ['browser_click'], 'an active gated tool executes normally');
    assert.ok(
      !h.pushed.some((e) => e.type === 'tool_result' && e.isError),
      'no synthetic error result for an active tool',
    );
  });

  test('is inert when no gating is installed (economy off)', async () => {
    const h = makeHarness();
    const implCalls: string[] = [];
    // No setGating call: any tool must execute as before.
    const t = tool('browser_click', implCalls);
    await run(h, t);

    assert.deepEqual(implCalls, ['browser_click'], 'guard must not fire without installed gating');
  });

  test('never gates a tool outside gatedNames, even when absent from the snapshot', async () => {
    const h = makeHarness();
    const implCalls: string[] = [];
    // Read is not a gated tool; the active snapshot is empty, yet Read must run.
    h.runtime.setGating({
      gatedNames: new Set(['browser_click']),
      activeNames: () => new Set<string>(),
    });
    const direct: MakaTool = {
      name: 'Read',
      description: 'Read',
      parameters: z.object({}),
      impl: () => {
        implCalls.push('Read');
        return { ok: true };
      },
    };
    await run(h, direct);
    assert.deepEqual(implCalls, ['Read']);
  });
});
