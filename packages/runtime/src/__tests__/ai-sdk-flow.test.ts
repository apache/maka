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

import type { BackendKind } from '@maka/core/session';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { SessionEvent } from '@maka/core/events';
import type { BackendSendInput, BackendSessionEvent } from '@maka/core/backend-types';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  decodeRuntimeEvent,
  isTerminalRuntimeEvent,
  isPartialRuntimeEvent,
} from '@maka/core/runtime-event';

import {
  AiSdkFlow,
  mapCompleteStopReason,
  mapSessionEventToRuntimeEvent,
  createSessionEventMapMemory,
} from '../ai-sdk-flow.js';
import type { AgentBackend } from '@maka/core/backend-types';
import { RuntimeRunner } from '../runtime-runner.js';
import type { InvocationContext } from '../invocation-context.js';
import {
  isUnclaimedRuntimeEventDiagnostic,
  projectRuntimeEventsToStoredMessages,
} from '../runtime-event-read-model.js';
import { isNonTerminalErrorRuntimeEvent } from '../agent-run.js';
import { backfillRuntimeEventsFromStoredMessages } from '../runtime-event-backfill.js';

// ============================================================================
// Fake backend — scripted SessionEvent stream + recorded control calls
// ============================================================================

interface ScriptedBackendCtor {
  kind?: BackendKind;
  sessionId?: string;
  events: SessionEvent[];
  /** Optional gate: send() awaits this after yielding each event. */
  gate?: () => Promise<void>;
  stopFailure?: Error;
}

class ScriptedBackend implements AgentBackend {
  readonly kind: BackendKind;
  readonly sessionId: string;
  readonly stopCalls: Array<'user_stop' | 'redirect'> = [];
  readonly permissionCalls: SandboxBoundaryResponse[] = [];
  readonly sendInputs: BackendSendInput[] = [];
  disposeCalls = 0;
  sendCalls = 0;
  yieldedEvents = 0;
  private readonly events: SessionEvent[];
  private readonly gate?: () => Promise<void>;
  private readonly stopFailure?: Error;

  constructor(c: ScriptedBackendCtor) {
    this.kind = c.kind ?? 'ai-sdk';
    this.sessionId = c.sessionId ?? 'session-1';
    this.events = c.events;
    this.gate = c.gate;
    this.stopFailure = c.stopFailure;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.sendCalls += 1;
    this.sendInputs.push(input);
    for (const e of this.events) {
      this.yieldedEvents += 1;
      yield e;
      if (this.gate) await this.gate();
    }
  }

  async stop(reason: 'user_stop' | 'redirect'): Promise<void> {
    this.stopCalls.push(reason);
    if (this.stopFailure) throw this.stopFailure;
  }

  async respondToSandboxBoundary(decision: SandboxBoundaryResponse): Promise<void> {
    this.permissionCalls.push(decision);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

// ============================================================================
// Event builders
// ============================================================================

let __seq = 0;
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
function ev(
  e: DistributiveOmit<SessionEvent, 'id' | 'turnId' | 'ts'> & Partial<Pick<SessionEvent, 'ts'>>,
): SessionEvent {
  __seq += 1;
  return { id: `evt-${__seq}`, turnId: 'turn-1', ts: e.ts ?? __seq, ...e } as SessionEvent;
}

const ctx = {
  sessionId: 'session-1',
  invocationId: 'inv-1',
  runId: 'run-1',
  turnId: 'turn-1',
  source: 'test',
  startedAt: 999,
  request: {
    sessionId: 'session-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    turnId: 'turn-1',
    text: 'hi',
    source: 'test',
  },
  newId: () => 'rt-id',
  now: () => 1000,
} satisfies InvocationContext;

function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  return (async () => {
    for await (const e of stream) out.push(e);
    return out;
  })();
}

// ============================================================================
// Tests
// ============================================================================

describe('AiSdkFlow seam', () => {
  test('maps the original steering content digest into the durable Runtime event', () => {
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const runtimeEvent = mapSessionEventToRuntimeEvent(
      {
        id: 'steering-event',
        turnId: 'turn-1',
        ts: 1,
        type: 'steering_message',
        messageId: 'steering-message',
        content: { text: '<invoked-skill>Prepared</invoked-skill>' },
        submittedContentDigest: digest,
      },
      ctx,
    );

    assert.equal(runtimeEvent.refs?.sourceMessageDigest, digest);
  });

  test('single-flights a pending backend stop and retries after it settles', async () => {
    const stopFailure = new Error('backend stop failed');
    const backend = new ScriptedBackend({ events: [], stopFailure });
    const flow = new AiSdkFlow({ backend });

    const results = await Promise.allSettled([flow.stop('user_stop'), flow.stop('redirect')]);

    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected'],
    );
    assert.equal(results[0]?.status === 'rejected' && results[0].reason, stopFailure);
    assert.equal(results[1]?.status === 'rejected' && results[1].reason, stopFailure);
    assert.deepEqual(backend.stopCalls, ['user_stop']);

    await assert.rejects(flow.stop('redirect'), stopFailure);
    assert.deepEqual(backend.stopCalls, ['user_stop', 'redirect']);
  });

  test('maps a normal turn preserving event order and terminal guarantee', async () => {
    const backend = new ScriptedBackend({
      events: [
        ev({ type: 'text_delta', messageId: 'm1', text: 'Hel' }),
        ev({ type: 'text_delta', messageId: 'm1', text: 'lo' }),
        ev({ type: 'text_complete', messageId: 'm1', text: 'Hello' }),
        ev({
          type: 'token_usage',
          input: 10,
          output: 5,
          costUsd: 0.001,
          systemPromptHash: 'sys-hash',
          providerRequestTraceId: 'provider-trace-1',
        }),
        ev({ type: 'complete', stopReason: 'end_turn' }),
      ],
    });
    const flow = new AiSdkFlow({ backend });

    const out = await collect(flow.run(ctx, { text: 'hi', context: [] }));

    assert.equal(out.length, 5);
    // Order preserved.
    assert.deepEqual(
      out.map((e) => e.content?.kind ?? null),
      ['text', 'text', 'text', null, null],
    );
    // Deltas are partial; complete is not.
    assert.equal(isPartialRuntimeEvent(out[0]), true);
    assert.equal(isPartialRuntimeEvent(out[2]), false);
    // Identity spine propagated.
    assert.equal(out[0].invocationId, 'inv-1');
    assert.equal(out[0].runId, 'run-1');
    assert.equal(out[0].sessionId, 'session-1');
    assert.equal(out[0].turnId, 'turn-1');
    // id reused from source for 1:1 dedup linkage.
    assert.equal(out[0].id, 'evt-1');
    // Token usage carried as an action.
    assert.deepEqual(out[3].actions?.tokenUsage, {
      input: 10,
      output: 5,
      costUsd: 0.001,
      systemPromptHash: 'sys-hash',
    });
    assert.deepEqual(out[3].refs, { providerRequestTraceId: 'provider-trace-1' });
    // Stream closes with a terminal event.
    assert.equal(isTerminalRuntimeEvent(out[out.length - 1]), true);
    assert.equal(out[out.length - 1].status, 'completed');
    assert.equal(out[out.length - 1].actions?.endInvocation, true);
    // send was invoked exactly once with the turn id.
    assert.equal(backend.sendCalls, 1);
  });

  test('RuntimeRunner dispatches AiSdkFlow with defined context and preserved attachments', async () => {
    const attachment = {
      kind: 'image' as const,
      name: 'chart.png',
      mimeType: 'image/png',
      bytes: 123,
      ref: {
        kind: 'session_file' as const,
        sessionId: 'session-1',
        relativePath: 'attachments/chart.png',
      },
    };
    const history = [
      {
        type: 'user' as const,
        id: 'u-prev',
        turnId: 'turn-prev',
        ts: 1,
        text: 'previous',
      },
    ];
    const runtimeContext: RuntimeEvent[] = [
      {
        id: 'rt-prev',
        invocationId: 'inv-prev',
        runId: 'run-prev',
        sessionId: 'session-1',
        turnId: 'turn-prev',
        ts: 1,
        partial: false,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'previous' },
      },
    ];
    const backend = new ScriptedBackend({
      events: [
        ev({ type: 'text_complete', messageId: 'm1', text: 'ok' }),
        ev({ type: 'complete', stopReason: 'end_turn' }),
      ],
    });
    const flow = new AiSdkFlow({ backend });
    let idSeq = 0;
    const runner = new RuntimeRunner({
      flow,
      providers: {
        newId: () => `rt-${(idSeq += 1)}`,
        now: () => 1000,
      },
    });

    const result = await runner.run({
      sessionId: 'session-1',
      turnId: 'turn-1',
      text: 'hi',
      attachments: [attachment],
      context: history,
      runtimeContext,
      source: 'test',
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.finalOutput, 'ok');
    assert.equal(backend.sendInputs.length, 1);
    assert.deepEqual(backend.sendInputs[0], {
      invocationId: 'rt-1',
      runId: 'rt-2',
      turnId: 'turn-1',
      text: 'hi',
      attachments: [attachment],
      context: history,
      runtimeContext,
    });
  });

  test('maps thinking deltas/signature onto model thinking content', async () => {
    const backend = new ScriptedBackend({
      events: [
        ev({ type: 'thinking_delta', messageId: 'm1', text: 'hm' }),
        ev({ type: 'thinking_complete', messageId: 'm1', text: 'hmm', signature: 'sig' }),
        ev({ type: 'complete', stopReason: 'end_turn' }),
      ],
    });
    const flow = new AiSdkFlow({ backend });
    const out = await collect(flow.run(ctx, { text: 'hi', context: [] }));

    assert.equal(isPartialRuntimeEvent(out[0]), true);
    assert.equal(out[1].content?.kind, 'thinking');
    assert.equal((out[1].content as { signature?: string }).signature, 'sig');
    assert.equal(isPartialRuntimeEvent(out[1]), false);
  });

  test('preserves toolName linkage between tool_start and tool_result', async () => {
    const backend = new ScriptedBackend({
      events: [
        ev({ type: 'tool_start', toolUseId: 'tu-1', toolName: 'read', args: { path: '/a' } }),
        ev({
          type: 'tool_result',
          toolUseId: 'tu-1',
          isError: false,
          content: { kind: 'text', text: 'body' },
          durationMs: 42,
        }),
        ev({ type: 'complete', stopReason: 'end_turn' }),
      ],
    });
    const flow = new AiSdkFlow({ backend });
    const out = await collect(flow.run(ctx, { text: 'read it', context: [] }));

    // tool_start -> function_call
    const call = out[0];
    assert.equal(call.role, 'model');
    assert.equal(call.author, 'agent');
    assert.equal(call.content?.kind, 'function_call');
    const fnCall = call.content as { id: string; name: string; args: unknown };
    assert.equal(fnCall.name, 'read');
    assert.equal(fnCall.id, 'tu-1');
    assert.equal(call.refs?.toolCallId, 'tu-1');

    // tool_result -> function_response with the remembered name
    const result = out[1];
    assert.equal(result.role, 'tool');
    assert.equal(result.author, 'tool');
    assert.equal(result.content?.kind, 'function_response');
    const fnResp = result.content as {
      id: string;
      name: string;
      result: unknown;
      isError?: boolean;
    };
    assert.equal(fnResp.name, 'read', 'tool_result recovers toolName from the prior tool_start');
    assert.equal(fnResp.isError, undefined);
    assert.equal(result.refs?.toolCallId, 'tu-1');
    assert.deepEqual(result.actions?.stateDelta, { durationMs: 42 });
  });

  test('maps sandbox boundary requests and decisions as first-class runtime actions', async () => {
    const backend = new ScriptedBackend({
      events: [
        ev({
          type: 'sandbox_boundary_request',
          requestId: 'boundary-1',
          toolUseId: 'tu-boundary',
          justification: 'Write the requested export.',
          expansion: {
            filesystem: {
              entries: [{ path: '/tmp/export.txt', access: 'write', scope: 'exact' }],
            },
          },
        }),
        ev({
          type: 'sandbox_boundary_decision_ack',
          requestId: 'boundary-1',
          toolUseId: 'tu-boundary',
          decision: 'allow',
          status: 'approved',
          revision: 2,
        }),
        ev({ type: 'complete', stopReason: 'end_turn' }),
      ],
    });
    const flow = new AiSdkFlow({ backend });
    const out = await collect(flow.run(ctx, { text: 'do it', context: [] }));

    const req = out[0];
    assert.equal(req.author, 'system');
    assert.deepEqual(req.actions?.stateDelta?.sandboxBoundaryRequest, {
      requestId: 'boundary-1',
      toolUseId: 'tu-boundary',
      justification: 'Write the requested export.',
      expansion: {
        filesystem: {
          entries: [{ path: '/tmp/export.txt', access: 'write', scope: 'exact' }],
        },
      },
    });

    const ack = out[1];
    assert.equal(ack.author, 'user');
    assert.deepEqual(ack.actions?.stateDelta?.sandboxBoundaryDecision, {
      requestId: 'boundary-1',
      decision: 'allow',
      status: 'approved',
      revision: 2,
    });
    assert.equal(out[2].status, 'completed');
  });

  test('maps the error path preserving error content + terminal failed', async () => {
    const backend = new ScriptedBackend({
      events: [
        ev({
          type: 'error',
          recoverable: false,
          code: 'AUTH',
          reason: 'auth_failed',
          message: 'no token',
        }),
        ev({ type: 'complete', stopReason: 'error' }),
      ],
    });
    const flow = new AiSdkFlow({ backend });
    const out = await collect(flow.run(ctx, { text: 'hi', context: [] }));

    const err = out[0];
    assert.equal(err.content?.kind, 'error');
    const errContent = err.content as { code?: string; reason?: string; message: string };
    assert.equal(errContent.message, 'no token');
    assert.equal(errContent.code, 'AUTH');
    assert.equal(errContent.reason, 'auth_failed');
    // error event itself is non-terminal; the trailing complete carries failed.
    assert.equal(isTerminalRuntimeEvent(err), false);

    assert.equal(out[1].status, 'failed');
    assert.equal(isTerminalRuntimeEvent(out[1]), true);
    assert.deepEqual(out[1].content, err.content);
  });

  test('synthesizes a failed terminal event when the backend exhausts without one', async () => {
    const seen: SessionEvent[] = [];
    let idSeq = 0;
    const backend = new ScriptedBackend({
      events: [ev({ type: 'text_delta', messageId: 'm1', text: 'partial answer' })],
    });
    const flow = new AiSdkFlow({
      backend,
      onSessionEvent: (sessionEvent) => {
        seen.push(sessionEvent);
      },
    });
    const out = await collect(
      flow.run(
        { ...ctx, newId: () => `synthetic-${(idSeq += 1)}`, now: () => 2000 },
        { text: 'hi', context: [] },
      ),
    );

    assert.deepEqual(
      seen.map((event) => event.type),
      ['text_delta', 'error', 'complete'],
    );
    assert.equal(seen[1]?.type, 'error');
    assert.equal(
      (seen[1] as Extract<SessionEvent, { type: 'error' }>).reason,
      'missing_terminal_event',
    );
    assert.equal(seen[2]?.type, 'complete');
    assert.equal((seen[2] as Extract<SessionEvent, { type: 'complete' }>).stopReason, 'error');
    assert.equal(out.at(-2)?.content?.kind, 'error');
    assert.equal(
      (out.at(-2)?.content as { reason?: string } | undefined)?.reason,
      'missing_terminal_event',
    );
    assert.equal(out.at(-1)?.status, 'failed');
    assert.equal(out.filter(isTerminalRuntimeEvent).length, 1);
  });

  test('maps the abort path to exactly one terminal event', async () => {
    const backend = new ScriptedBackend({
      events: [
        ev({ type: 'text_delta', messageId: 'm1', text: 'par' }),
        ev({ type: 'abort', reason: 'user_stop' }),
        ev({ type: 'complete', stopReason: 'user_stop' }),
      ],
    });
    const flow = new AiSdkFlow({ backend });
    const out = await collect(flow.run(ctx, { text: 'hi', context: [] }));

    // AgentFlow guarantees exactly one terminal event, so the trailing
    // complete(user_stop) from the legacy backend is coalesced away.
    assert.equal(out.length, 2);
    assert.equal(out[1].status, 'aborted');
    assert.equal(out[1].actions?.endInvocation, true);
    assert.equal(isTerminalRuntimeEvent(out[1]), true);
    assert.equal(out.filter(isTerminalRuntimeEvent).length, 1);
  });

  test('stops yielding after the first terminal event', async () => {
    const backend = new ScriptedBackend({
      events: [
        ev({ type: 'abort', reason: 'user_stop' }),
        ev({ type: 'text_delta', messageId: 'm1', text: 'after-terminal' }),
        ev({ type: 'complete', stopReason: 'user_stop' }),
      ],
    });
    const flow = new AiSdkFlow({ backend });
    const out = await collect(flow.run(ctx, { text: 'hi', context: [] }));

    assert.equal(out.length, 1);
    assert.equal(out[0]?.status, 'aborted');
    assert.equal(isTerminalRuntimeEvent(out[0]), true);
  });

  test('can silently drain backend events after a terminal while coalescing duplicate terminals', async () => {
    const seen: SessionEvent[] = [];
    const backend = new ScriptedBackend({
      events: [
        ev({ type: 'abort', reason: 'user_stop' }),
        ev({ type: 'text_delta', messageId: 'm1', text: 'cleanup-after-terminal' }),
        ev({ type: 'complete', stopReason: 'user_stop' }),
      ],
    });
    const flow = new AiSdkFlow({
      backend,
      drainAfterTerminal: true,
      onSessionEvent: (sessionEvent) => {
        seen.push(sessionEvent);
      },
    });
    const out = await collect(flow.run(ctx, { text: 'hi', context: [] }));

    assert.equal(backend.yieldedEvents, 3);
    assert.deepEqual(
      seen.map((event) => event.type),
      ['abort'],
    );
    assert.deepEqual(
      out.map((event) => event.content?.kind ?? event.status ?? null),
      ['aborted'],
    );
    assert.equal(out.filter(isTerminalRuntimeEvent).length, 1);
  });

  test('reports terminal onSessionEvent failures before accepting the terminal event', async () => {
    const seenErrors: string[] = [];
    const backend = new ScriptedBackend({
      events: [
        ev({ type: 'complete', stopReason: 'end_turn' }),
        ev({ type: 'text_delta', messageId: 'm1', text: 'after-terminal' }),
      ],
    });
    const flow = new AiSdkFlow({
      backend,
      drainAfterTerminal: true,
      onSessionEvent: () => {
        throw new Error('terminal write failed');
      },
      onError: (error) => {
        seenErrors.push(error instanceof Error ? error.message : String(error));
      },
    });

    await assert.rejects(
      collect(flow.run(ctx, { text: 'hi', context: [] })),
      /terminal write failed/,
    );
    assert.deepEqual(seenErrors, ['terminal write failed']);
    assert.equal(backend.yieldedEvents, 1);
  });

  test('RuntimeRunner consumes AiSdkFlow abort as one coherent failed outcome', async () => {
    const backend = new ScriptedBackend({
      events: [
        ev({ type: 'text_delta', messageId: 'm1', text: 'par' }),
        ev({ type: 'abort', reason: 'user_stop' }),
        ev({ type: 'complete', stopReason: 'user_stop' }),
      ],
    });
    const flow = new AiSdkFlow({ backend });
    let idSeq = 0;
    const runner = new RuntimeRunner({
      flow,
      providers: {
        newId: () => `id-${(idSeq += 1)}`,
        now: () => 1000,
      },
    });

    const result = await runner.run({
      sessionId: 'session-1',
      turnId: 'turn-1',
      text: 'hi',
      source: 'test',
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.failure?.class, 'aborted');
    assert.equal(result.events.filter(isTerminalRuntimeEvent).length, 1);
  });

  test('delegates stop / respondToSandboxBoundary / dispose to the wrapped backend', async () => {
    const backend = new ScriptedBackend({ events: [] });
    const flow = new AiSdkFlow({ backend });

    await flow.stop('redirect');
    await flow.respondToSandboxBoundary({ requestId: 'r', decision: 'allow' });
    await flow.dispose();

    assert.deepEqual(backend.stopCalls, ['redirect']);
    assert.deepEqual(backend.permissionCalls, [{ requestId: 'r', decision: 'allow' }]);
    assert.equal(backend.disposeCalls, 1);
  });

  test('throws on session id mismatch between ctx and backend', async () => {
    const backend = new ScriptedBackend({ sessionId: 'session-1', events: [] });
    const flow = new AiSdkFlow({ backend });

    await assert.rejects(
      collect(flow.run({ ...ctx, sessionId: 'other' }, { text: 'hi', context: [] })),
      /AiSdkFlow session mismatch/,
    );
  });

  test('bridges FlowInput.abortSignal onto backend.stop("user_stop")', async () => {
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const backend = new ScriptedBackend({
      events: [
        ev({ type: 'text_delta', messageId: 'm1', text: 'x' }),
        ev({ type: 'complete', stopReason: 'end_turn' }),
      ],
      gate: () => gate,
    });
    // stop releases the gate so send() can advance to the terminal event.
    const realStop = backend.stop.bind(backend);
    backend.stop = async (reason) => {
      await realStop(reason);
      releaseGate();
    };

    const flow = new AiSdkFlow({ backend });
    const ctrl = new AbortController();
    const runPromise = collect(
      flow.run(ctx, { text: 'hi', context: [], abortSignal: ctrl.signal }),
    );

    // Let the generator yield the first event and park on the gate.
    await new Promise((r) => setTimeout(r, 0));
    ctrl.abort();
    const out = await runPromise;

    assert.deepEqual(backend.stopCalls, ['user_stop']);
    assert.equal(out.length, 2);
    assert.equal(isTerminalRuntimeEvent(out[out.length - 1]), true);
  });

  test('maps provider retry progress as a partial non-terminal runtime fact', () => {
    const retry = ev({
      type: 'provider_retry',
      phase: 'scheduled',
      attempt: 2,
      maxAttempts: 10,
      delayMs: 4_000,
      reason: 'rate_limit',
    });

    const mapped = mapSessionEventToRuntimeEvent(retry, ctx);

    assert.equal(mapped.partial, true);
    assert.equal(isTerminalRuntimeEvent(mapped), false);
    assert.deepEqual(mapped.actions?.stateDelta, {
      providerRetry: {
        phase: 'scheduled',
        attempt: 2,
        maxAttempts: 10,
        delayMs: 4_000,
        reason: 'rate_limit',
      },
    });
  });
});

// ============================================================================
// Pure mapping unit tests
// ============================================================================

describe('mapSessionEventToRuntimeEvent (pure)', () => {
  test('mapCompleteStopReason covers all stop reasons', () => {
    assert.equal(mapCompleteStopReason('end_turn'), 'completed');
    assert.equal(mapCompleteStopReason('max_tokens'), 'completed');
    assert.equal(mapCompleteStopReason('plan_handoff'), 'completed');
    assert.equal(mapCompleteStopReason('graph_yield'), 'completed');
    assert.equal(mapCompleteStopReason('permission_handoff'), 'completed');
    assert.equal(mapCompleteStopReason('user_stop'), 'aborted');
    assert.equal(mapCompleteStopReason('error'), 'failed');
    assert.equal(mapCompleteStopReason('step_limit'), 'failed');
  });

  test('step_limit uses the established tool-step-cap failure class', () => {
    const mapped = mapSessionEventToRuntimeEvent(
      ev({ type: 'complete', stopReason: 'step_limit' }),
      ctx,
      createSessionEventMapMemory(),
    );

    assert.deepEqual(mapped.actions?.stateDelta, {
      stopReason: 'step_limit',
      failureClass: 'tool_step_cap_reached',
    });
  });

  test('context_budget_exhausted keeps its detail in the durable terminal state', () => {
    const mapped = mapSessionEventToRuntimeEvent(
      ev({
        type: 'complete',
        stopReason: 'context_budget_exhausted',
        contextBudgetExhaustedDetail: 'head_anchor_exceeds_capacity',
      }),
      ctx,
      createSessionEventMapMemory(),
    );

    assert.equal(mapped.status, 'failed');
    assert.deepEqual(mapped.actions?.stateDelta, {
      stopReason: 'context_budget_exhausted',
      failureClass: 'context_budget_exhausted',
      contextBudgetExhaustedDetail: 'head_anchor_exceeds_capacity',
    });
  });

  test('tool_output_delta and tool_progress map to partial tool-role heartbeats', () => {
    const mem = createSessionEventMapMemory();
    const a = mapSessionEventToRuntimeEvent(
      ev({
        type: 'tool_output_delta',
        sessionId: 'session-1',
        toolCallId: 'tu-1',
        toolUseId: 'tu-1',
        seq: 1,
        stream: 'stdout',
        chunk: 'c',
        redacted: false,
        createdAt: 1,
      }),
      ctx,
      mem,
    );
    assert.equal(a.partial, true);
    assert.equal(a.role, 'tool');
    assert.equal(a.author, 'tool');
    assert.equal(a.refs?.toolCallId, 'tu-1');

    const b = mapSessionEventToRuntimeEvent(
      ev({ type: 'tool_progress', toolUseId: 'tu-1', chunk: 'c' }),
      ctx,
      mem,
    );
    assert.equal(b.partial, true);
    assert.equal(b.role, 'tool');
  });

  test('tool activity mapping retains nested CodeMode replay and parent identity', () => {
    const memory = createSessionEventMapMemory();
    const start = mapSessionEventToRuntimeEvent(
      ev({
        type: 'tool_start',
        toolUseId: 'nested-1',
        toolName: 'Read',
        operationId: 'nested-op-1',
        args: {},
        origin: 'code_mode',
        modelVisibility: 'hidden',
        parentToolCallId: 'exec-1',
        parentOperationId: 'exec-op-1',
      }),
      ctx,
      memory,
    );
    const result = mapSessionEventToRuntimeEvent(
      ev({
        type: 'tool_result',
        toolUseId: 'nested-1',
        operationId: 'nested-op-1',
        isError: false,
        content: { kind: 'text', text: 'ok' },
        origin: 'code_mode',
        modelVisibility: 'hidden',
        parentToolCallId: 'exec-1',
        parentOperationId: 'exec-op-1',
      }),
      ctx,
      memory,
    );

    for (const event of [start, result]) {
      assert.equal(event.origin, 'code_mode');
      assert.equal(event.modelVisibility, 'hidden');
      assert.equal(event.refs?.parentToolCallId, 'exec-1');
      assert.equal(event.refs?.parentOperationId, 'exec-op-1');
    }
  });

  test('owns independent tool args across SessionEvent to RuntimeEvent mappings', () => {
    const sourceArgs = { content: 'approved', layout: { cols: 120 } };
    const sourceEvent = ev({
      type: 'tool_start',
      toolUseId: 'tu-owned',
      toolName: 'Write',
      args: sourceArgs,
    });
    const mapped = mapSessionEventToRuntimeEvent(sourceEvent, ctx, createSessionEventMapMemory());
    const mappedArgs = (
      mapped.content?.kind === 'function_call' ? mapped.content.args : undefined
    ) as typeof sourceArgs;

    assert.notStrictEqual(mappedArgs, sourceArgs);
    assert.notStrictEqual(mappedArgs.layout, sourceArgs.layout);
    sourceArgs.layout.cols = 80;
    assert.equal(mappedArgs.layout.cols, 120);
    mappedArgs.content = 'runtime';
    assert.equal(sourceArgs.content, 'approved');
  });

  test('plan_submitted maps to an agent-authored state delta', () => {
    const a = mapSessionEventToRuntimeEvent(
      ev({ type: 'plan_submitted', planId: 'p1', title: 'T', markdownPath: '/p.md' }),
      ctx,
    );
    assert.equal(a.role, 'system');
    assert.equal(a.author, 'agent');
    assert.deepEqual(a.actions?.stateDelta, { planId: 'p1', title: 'T', markdownPath: '/p.md' });
  });

  test('user_question_request maps to one system-authored runtime action', () => {
    const mapped = mapSessionEventToRuntimeEvent(
      ev({
        type: 'user_question_request',
        requestId: 'question-1',
        toolUseId: 'tool-1',
        questions: [
          {
            question: 'Choose an approach',
            options: [
              { label: 'Extend', description: 'Reuse the runtime seam' },
              { label: 'Separate' },
            ],
          },
        ],
      }),
      ctx,
    );

    assert.equal(mapped.role, 'system');
    assert.equal(mapped.author, 'system');
    assert.deepEqual(mapped.actions?.userQuestionRequest, {
      requestId: 'question-1',
      toolUseId: 'tool-1',
      questions: [
        {
          question: 'Choose an approach',
          options: [
            { label: 'Extend', description: 'Reuse the runtime seam' },
            { label: 'Separate' },
          ],
        },
      ],
    });
  });

  test('user_question_answer_ack maps without duplicating the canonical answer', () => {
    const mapped = mapSessionEventToRuntimeEvent(
      ev({
        type: 'user_question_answer_ack',
        requestId: 'question-1',
        toolUseId: 'tool-1',
      }),
      ctx,
    );

    assert.equal(mapped.role, 'system');
    assert.equal(mapped.author, 'user');
    assert.deepEqual(mapped.actions?.userQuestionAnswerAccepted, {
      requestId: 'question-1',
    });
    assert.equal(mapped.refs?.toolCallId, 'tool-1');
  });

  test('tool_result without a prior tool_start still maps (name falls back to empty)', () => {
    const a = mapSessionEventToRuntimeEvent(
      ev({
        type: 'tool_result',
        toolUseId: 'orphan',
        isError: true,
        content: { kind: 'text', text: 'boom' },
      }),
      ctx,
    );
    const fnResp = a.content as { name: string; isError?: boolean };
    assert.equal(fnResp.name, '');
    assert.equal(fnResp.isError, true);
  });

  test('branch is propagated when present on the context', () => {
    const a = mapSessionEventToRuntimeEvent(ev({ type: 'complete', stopReason: 'end_turn' }), {
      ...ctx,
      branch: 'agent-b',
    });
    assert.equal(a.branch, 'agent-b');
  });
});

// ============================================================================
// Projection coverage contract
// ============================================================================

/**
 * One sample per backend-mappable SessionEvent variant. `subject` is typed to
 * its own key, so a new variant cannot be satisfied by an empty list or by
 * some other event that happens to project cleanly; `before` and `after` carry
 * only the companions that variant's projection needs.
 */
type ProjectionSamples = {
  [K in BackendSessionEvent['type']]: {
    subject: Extract<BackendSessionEvent, { type: K }>;
    before?: SessionEvent[];
    after?: SessionEvent[];
  };
};

const PROJECTION_SAMPLES: ProjectionSamples = {
  text_delta: {
    subject: { type: 'text_delta', id: 'e', turnId: 'turn-1', ts: 1, messageId: 'm1', text: 'h' },
  },
  text_complete: {
    subject: {
      type: 'text_complete',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'm1',
      text: 'hi',
    },
  },
  thinking_delta: {
    subject: {
      type: 'thinking_delta',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'm1',
      text: 'h',
    },
  },
  thinking_complete: {
    subject: {
      type: 'thinking_complete',
      id: 'e1',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'm1',
      text: 'why',
    },
    // Thinking is held until the assistant text row that shares its message id.
    after: [
      { type: 'text_complete', id: 'e2', turnId: 'turn-1', ts: 2, messageId: 'm1', text: 'hi' },
    ],
  },
  tool_start: {
    subject: {
      type: 'tool_start',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
      toolName: 'Read',
      args: { path: '/tmp/a' },
    },
  },
  tool_output_delta: {
    subject: {
      type: 'tool_output_delta',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolUseId: 'tool-1',
      seq: 1,
      stream: 'stdout',
      chunk: 'out',
      redacted: false,
      createdAt: 1,
    },
  },
  tool_progress: {
    subject: {
      type: 'tool_progress',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
      chunk: 'x',
    },
  },
  tool_result_preview: {
    subject: {
      type: 'tool_result_preview',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
      isError: false,
      content: {
        kind: 'subagent',
        childSessionId: 'child-1',
        agentName: 'Local Read',
        turnId: 'child-turn',
        status: 'running',
        permissionMode: 'explore',
      },
    },
  },
  tool_result: {
    subject: {
      type: 'tool_result',
      id: 'e2',
      turnId: 'turn-1',
      ts: 2,
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'text', text: 'ok' },
    },
    // A result carries no tool name of its own; the mapper reads it from the call.
    before: [
      {
        type: 'tool_start',
        id: 'e1',
        turnId: 'turn-1',
        ts: 1,
        toolUseId: 'tool-1',
        toolName: 'Read',
        args: { path: '/tmp/a' },
      },
    ],
  },
  sandbox_boundary_request: {
    subject: {
      type: 'sandbox_boundary_request',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      justification: 'read a file outside the workspace',
      expansion: {
        filesystem: { entries: [{ path: '/tmp/outside.txt', access: 'read', scope: 'exact' }] },
      },
    },
  },
  sandbox_boundary_decision_ack: {
    subject: {
      type: 'sandbox_boundary_decision_ack',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      decision: 'allow',
      status: 'approved',
      revision: 2,
    },
  },
  user_question_request: {
    subject: {
      type: 'user_question_request',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'q-1',
      toolUseId: 'tool-1',
      questions: [{ question: 'Which one?', options: [{ label: 'A', description: 'a' }] }],
    },
  },
  user_question_answer_ack: {
    subject: {
      type: 'user_question_answer_ack',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'q-1',
      toolUseId: 'tool-1',
    },
  },
  plan_submitted: {
    subject: {
      type: 'plan_submitted',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      planId: 'plan-1',
      title: 'Plan',
    },
  },
  token_usage: {
    subject: {
      type: 'token_usage',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      input: 10,
      output: 5,
      total: 15,
    },
  },
  steering_message: {
    subject: {
      type: 'steering_message',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'm2',
      content: { text: 'steer' },
    },
  },
  provider_retry: {
    subject: {
      type: 'provider_retry',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      phase: 'started',
      attempt: 2,
      maxAttempts: 3,
      reason: 'rate_limit',
    },
  },
  error: {
    subject: {
      type: 'error',
      id: 'e1',
      turnId: 'turn-1',
      ts: 1,
      recoverable: false,
      message: 'boom',
    },
    // An error is always followed by a terminal complete carrying the failure.
    after: [{ type: 'complete', id: 'e2', turnId: 'turn-1', ts: 2, stopReason: 'error' }],
  },
  complete: {
    subject: { type: 'complete', id: 'e', turnId: 'turn-1', ts: 1, stopReason: 'end_turn' },
  },
  abort: { subject: { type: 'abort', id: 'e', turnId: 'turn-1', ts: 1, reason: 'user_stop' } },
};

const projectionRunHeader: AgentRunHeader = {
  runId: 'run-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  status: 'completed',
  backendKind: 'ai-sdk',
  llmConnectionSlug: 'anthropic',
  modelId: 'model-1',
  cwd: '/tmp',
  permissionMode: 'ask',
  createdAt: 1,
  updatedAt: 2,
  completedAt: 2,
};

describe('SessionEvent projection coverage', () => {
  // The contract is over what a reader can actually meet: every mapped event
  // AgentRun admits to the ledger has to project. It asserts on the unclaimed
  // codes at either severity, not on the hard one alone — a control fact whose
  // gap only degrades the view is still a gap, and must be found here rather
  // than by a user opening the session.
  for (const [type, sample] of Object.entries(PROJECTION_SAMPLES)) {
    test(`${type} projects without an unclaimed-event diagnostic`, () => {
      let seq = 0;
      const memory = createSessionEventMapMemory();
      const runtimeEvents = [...(sample.before ?? []), sample.subject, ...(sample.after ?? [])]
        .map((event) =>
          mapSessionEventToRuntimeEvent(
            event,
            {
              ...ctx,
              newId: () => {
                seq += 1;
                return `rt-${seq}`;
              },
            },
            memory,
          ),
        )
        .filter((event) => !isNonTerminalErrorRuntimeEvent(event));

      const projected = projectRuntimeEventsToStoredMessages(runtimeEvents, {
        runHeaders: [projectionRunHeader],
      });

      assert.deepEqual(projected.diagnostics.filter(isUnclaimedRuntimeEventDiagnostic), []);
    });
  }

  // The guard's fallback is what a variant added without a claim actually
  // becomes. It has to stay on the degradable side of the line: control-only,
  // so the session it lands in still opens, and still reported so the gap the
  // coverage contract would have caught is not invisible at runtime.
  test('an unmapped SessionEvent maps to a reported control-only fact', () => {
    const unmapped = { type: 'not_yet_mapped', id: 'e', turnId: 'turn-1', ts: 1 };
    const memory = createSessionEventMapMemory();
    const runtimeEvent = mapSessionEventToRuntimeEvent(
      unmapped as unknown as SessionEvent,
      ctx,
      memory,
    );

    assert.equal(runtimeEvent.content, undefined);
    assert.equal(runtimeEvent.actions?.stateDelta?.unmappedSessionEventType, 'not_yet_mapped');

    const projected = projectRuntimeEventsToStoredMessages([runtimeEvent], {
      runHeaders: [projectionRunHeader],
    });
    assert.deepEqual(projected.messages, []);
    // Filtered through the predicate the contract above uses, not just compared
    // to the code string: dropping the soft code from the predicate would
    // otherwise loosen the contract to `unsupported_event` only, silently.
    assert.deepEqual(
      projected.diagnostics.filter(isUnclaimedRuntimeEventDiagnostic).map((d) => d.code),
      ['unclaimed_control_fact'],
    );
    assert.equal(projected.diagnostics.length, 1);
  });
});
