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
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { SessionHeader } from '@maka/core/session';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { z } from 'zod';

import { createSessionEventMapMemory, mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';
import type { InvocationContext } from '../invocation-context.js';
import type { MakaTool } from '../tool-runtime.js';
import { createTestAiSdkBackend } from './execution-boundary-test-helpers.js';

/**
 * Production-path regression coverage for the execution boundary introduced by
 * tool-call-execution-guard.ts. Every assertion reaches the real
 * AiSdkBackend -> ModelAdapter -> ToolRuntime settlement path and checks the
 * irreversible result (zero executions or exactly one), rather than restating
 * the guard implementation.
 */

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/tmp/maka-repro',
    cwd: '/tmp/maka-repro',
    createdAt: 1,
    name: 'Repro',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function idGenerator(): () => string {
  let index = 0;
  return () => `id-${++index}`;
}

function monotonicClock(): () => number {
  let value = 1_000;
  return () => ++value;
}

function durableTurnHarness(turnId: string, text: string) {
  const runId = 'run-1';
  const invocationId = 'invocation-1';
  const anchor: RuntimeEvent = {
    id: `runtime-user-${turnId}`,
    invocationId,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
  const ledger: RuntimeEvent[] = [anchor];
  const memory = createSessionEventMapMemory();
  const ctx: InvocationContext = {
    sessionId: 'session-1',
    invocationId,
    runId,
    turnId,
    source: 'desktop',
    startedAt: 1,
    request: {
      sessionId: 'session-1',
      turnId,
      text,
      source: 'desktop',
      initialRuntimeEvent: anchor,
    },
    newId: idGenerator(),
    now: monotonicClock(),
  };
  return {
    anchor,
    ledger,
    loadTurnRuntimeEvents: async (requestedTurnId: string) =>
      ledger.filter((event) => event.turnId === requestedTurnId),
    input: (overrides: Partial<BackendSendInput> = {}): BackendSendInput => ({
      turnId,
      text,
      context: [],
      headAnchorRuntimeEvent: anchor,
      ...overrides,
    }),
    record: (event: SessionEvent): void => {
      const mapped = mapSessionEventToRuntimeEvent(event, ctx, memory);
      if (mapped.partial !== true && mapped.content?.kind !== 'error') ledger.push(mapped);
    },
  };
}

async function drainDurably(
  iterable: AsyncIterable<SessionEvent>,
  durable: ReturnType<typeof durableTurnHarness>,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    durable.record(event);
    events.push(event);
  }
  return events;
}

const ZERO_USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function hangingProviderStream(
  chunks: readonly LanguageModelV4StreamPart[],
  signal: AbortSignal | undefined,
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      const abort = () => controller.error(signal?.reason ?? new Error('aborted'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    },
  });
}

type UnifiedFinishReason = 'length' | 'stop' | 'tool-calls' | 'content-filter' | 'error' | 'other';

type FinishReason = {
  unified: UnifiedFinishReason;
  raw: string | undefined;
};

function doneChunks(): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-final' },
    { type: 'text-delta', id: 'text-final', delta: 'done' },
    { type: 'text-end', id: 'text-final' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: ZERO_USAGE,
    },
  ];
}

function twoStepModel(firstChunks: LanguageModelV4StreamPart[]): MockLanguageModelV4 {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      return {
        stream: simulateReadableStream({
          chunks: calls === 1 ? firstChunks : doneChunks(),
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}

function toolCallChunks(
  delivery: 'incremental' | 'atomic',
  finishReason: FinishReason,
  options: {
    rawId?: string;
    resolvedId?: string;
    rawToolName?: string;
    resolvedToolName?: string;
    rawInput?: unknown;
    projectedInput?: unknown;
  } = {},
): LanguageModelV4StreamPart[] {
  const rawId = options.rawId ?? 'call-1';
  const resolvedId = options.resolvedId ?? rawId;
  const rawToolName = options.rawToolName ?? 'Write';
  const resolvedToolName = options.resolvedToolName ?? rawToolName;
  const rawInput = options.rawInput ?? { path: 'notes.md', content: 'hello from the model' };
  const projectedInput = options.projectedInput ?? rawInput;
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: rawId, toolName: rawToolName },
  ];
  if (delivery === 'incremental') {
    chunks.push({ type: 'tool-input-delta', id: rawId, delta: JSON.stringify(rawInput) });
  }
  chunks.push(
    { type: 'tool-input-end', id: rawId },
    {
      type: 'tool-call',
      toolCallId: resolvedId,
      toolName: resolvedToolName,
      input: JSON.stringify(projectedInput),
    },
    { type: 'finish', finishReason, usage: ZERO_USAGE },
  );
  return chunks;
}

function writeTool(onExecute: (input: unknown) => void): MakaTool {
  return {
    name: 'Write',
    description: 'Write file contents',
    parameters: z.object({ path: z.string(), content: z.string() }),
    impl: async (input) => {
      onExecute(input);
      return { ok: true };
    },
  };
}

function notifyTool(onExecute: (input: unknown) => void): MakaTool {
  return {
    name: 'Notify',
    description: 'Send a notification',
    parameters: z.object({ message: z.string() }),
    impl: async (input) => {
      onExecute(input);
      return { ok: true };
    },
  };
}

function shellTool(onExecute: (input: unknown) => void): MakaTool {
  return {
    name: 'Shell',
    description: 'Run a shell command',
    parameters: z.object({ command: z.string() }),
    impl: async (input) => {
      onExecute(input);
      return { ok: true };
    },
  };
}

/** A genuinely zero-argument tool -- the schema itself takes nothing. */
function pingTool(onExecute: (input: unknown) => void): MakaTool {
  return {
    name: 'Ping',
    description: 'Zero-argument health check',
    parameters: z.object({}),
    impl: async (input) => {
      onExecute(input);
      return { ok: true };
    },
  };
}

/** Zero required arguments, but a declared default -- composes with P1. */
function listTodosTool(onExecute: (input: unknown) => void): MakaTool {
  return {
    name: 'ListTodos',
    description: 'List todos',
    parameters: z.object({ limit: z.number().default(10) }),
    impl: async (input) => {
      onExecute(input);
      return { ok: true };
    },
  };
}

async function runModel(
  model: MockLanguageModelV4,
  tools: MakaTool[],
  turnId = 'turn-1',
): Promise<SessionEvent[]> {
  const durable = durableTurnHarness(turnId, 'write it');
  const backend = createTestAiSdkBackend({
    sessionId: `session-${turnId}`,
    header: header(),
    appendMessage: async () => {},
    connection: connection(),
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    tools,
    loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
    newId: idGenerator(),
    now: monotonicClock(),
  });
  return drainDurably(backend.send(durable.input()), durable);
}

async function executionCountFor(
  delivery: 'incremental' | 'atomic',
  finishReason: FinishReason,
): Promise<number> {
  let executions = 0;
  const model = twoStepModel(toolCallChunks(delivery, finishReason));
  await runModel(model, [
    writeTool(() => {
      executions += 1;
    }),
  ]).catch(() => []);
  return executions;
}

describe('tool execution safety (real production path)', () => {
  for (const delivery of ['incremental', 'atomic'] as const) {
    for (const scenario of [
      { unified: 'stop', raw: 'stop', executions: 1 },
      { unified: 'tool-calls', raw: 'tool_calls', executions: 1 },
      { unified: 'length', raw: 'length', executions: 0 },
      { unified: 'content-filter', raw: 'content_filter', executions: 0 },
      { unified: 'error', raw: 'error', executions: 0 },
      { unified: 'other', raw: 'other', executions: 0 },
    ] as const) {
      test(`${delivery} + ${scenario.unified}: executes ${scenario.executions} time(s)`, async () => {
        const executions = await executionCountFor(delivery, {
          unified: scenario.unified,
          raw: scenario.raw,
        });
        assert.equal(executions, scenario.executions);
      });
    }
  }

  // Finish-reason authority: chunkFinishReason (model-adapter.ts) already
  // resolves "other" through the provider's own raw spelling for step
  // settlement. This proves the guard's own terminal classification for an
  // incrementally-streamed call now agrees with that resolution end to end,
  // through the real ModelAdapter -> resolveToolCallSafety wiring, rather
  // than only in the unit-level tracker tests. ("unknown" is exercised at
  // the unit level only — it is Maka's own settlement-layer fallback, never
  // a value a real raw SDK finish chunk's own `unified` field carries.)
  test('incremental + finish reason unified "other" but raw "stop": executes once', async () => {
    const executions = await executionCountFor('incremental', { unified: 'other', raw: 'stop' });
    assert.equal(executions, 1);
  });

  test('missing terminal event executes zero times', async () => {
    let executions = 0;
    const chunks = toolCallChunks('incremental', { unified: 'stop', raw: 'stop' }).slice(0, -1);
    await runModel(twoStepModel(chunks), [
      writeTool(() => {
        executions += 1;
      }),
    ]).catch(() => []);
    assert.equal(executions, 0);
  });

  test('truncated raw arguments without tool-input-end execute zero times', async () => {
    let executions = 0;
    const model = twoStepModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call-1', toolName: 'Write' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"path":"notes.md","content":"unf' },
      {
        type: 'finish',
        finishReason: { unified: 'length', raw: 'length' },
        usage: ZERO_USAGE,
      },
    ]);
    await runModel(model, [
      writeTool(() => {
        executions += 1;
      }),
    ]).catch(() => []);
    assert.equal(executions, 0);
  });

  test('abort after a complete incremental call but before terminal finish executes zero times', async () => {
    let executions = 0;
    const durable = durableTurnHarness('turn-abort', 'write it');
    const chunksEnqueued = makeGate();
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        const chunks = toolCallChunks('incremental', { unified: 'stop', raw: 'stop' }).slice(0, -1);
        const stream = hangingProviderStream(chunks, options.abortSignal);
        chunksEnqueued.release();
        return { stream };
      },
    });
    const backend = createTestAiSdkBackend({
      sessionId: 'session-abort',
      header: header(),
      appendMessage: async () => {},
      connection: connection(),
      apiKey: 'sk-test',
      modelId: 'mock-model-id',
      modelFactory: () => model,
      tools: [
        writeTool(() => {
          executions += 1;
        }),
      ],
      loadTurnRuntimeEvents: durable.loadTurnRuntimeEvents,
      newId: idGenerator(),
      now: monotonicClock(),
    });
    const drainPromise = drainDurably(backend.send(durable.input()), durable).catch(() => []);
    await chunksEnqueued.promise;
    await backend.stop('user_stop');
    await drainPromise;
    assert.equal(executions, 0);
  });

  test('concurrent incremental requests sharing call_1 stay isolated', async () => {
    let safeExecutions = 0;
    let unsafeExecutions = 0;
    const safe = runModel(
      twoStepModel(toolCallChunks('incremental', { unified: 'stop', raw: 'stop' })),
      [
        writeTool(() => {
          safeExecutions += 1;
        }),
      ],
      'turn-safe',
    );
    const unsafe = runModel(
      twoStepModel(toolCallChunks('incremental', { unified: 'length', raw: 'length' })),
      [
        writeTool(() => {
          unsafeExecutions += 1;
        }),
      ],
      'turn-unsafe',
    ).catch(() => []);
    await unsafe;
    await safe;
    assert.equal(safeExecutions, 1);
    assert.equal(unsafeExecutions, 0);
  });

  test('concurrent atomic requests sharing call_1 stay isolated', async () => {
    let safeExecutions = 0;
    let unsafeExecutions = 0;
    const safe = runModel(
      twoStepModel(toolCallChunks('atomic', { unified: 'stop', raw: 'stop' })),
      [
        writeTool(() => {
          safeExecutions += 1;
        }),
      ],
      'turn-safe-atomic',
    );
    const unsafe = runModel(
      twoStepModel(toolCallChunks('atomic', { unified: 'length', raw: 'length' })),
      [
        writeTool(() => {
          unsafeExecutions += 1;
        }),
      ],
      'turn-unsafe-atomic',
    ).catch(() => []);
    await unsafe;
    await safe;
    assert.equal(safeExecutions, 1);
    assert.equal(unsafeExecutions, 0);
  });

  test('raw evidence for call_1 cannot authorize a resolved call_2', async () => {
    let executions = 0;
    const model = twoStepModel(
      toolCallChunks(
        'incremental',
        { unified: 'stop', raw: 'stop' },
        {
          rawId: 'call_1',
          resolvedId: 'call_2',
        },
      ),
    );
    await runModel(model, [
      writeTool(() => {
        executions += 1;
      }),
    ]).catch(() => []);
    assert.equal(executions, 0);
  });

  // This is the installed Google adapter's real mixed-delivery shape: an
  // argument-bearing tool call streams start/delta.../end/final-call, while a
  // genuinely zero-argument sibling in the SAME physical request legitimately
  // streams start/end/final-call with ZERO tool-input-delta chunks. Each
  // call's eligibility must come only from its own lifecycle — the
  // argument-bearing sibling having raw evidence must not poison the
  // zero-argument sibling's own, independently-proved atomic completion.
  // A. A genuinely zero-argument sibling -- the installed Google adapter's
  // real wire shape, input "{}" -- executes from its own atomic proof,
  // isolated from an argument-bearing sibling in the same physical request.
  test('a legitimate zero-argument sibling executes from its own atomic proof, isolated from an argument-bearing sibling', async () => {
    let writeExecutions = 0;
    let pingExecutions = 0;
    let writeReceived: unknown;
    let pingReceived: unknown;
    const writeInput = { path: 'notes.md', content: 'hello' };
    const model = twoStepModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call-incremental', toolName: 'Write' },
      {
        type: 'tool-input-delta',
        id: 'call-incremental',
        delta: JSON.stringify(writeInput),
      },
      { type: 'tool-input-end', id: 'call-incremental' },
      {
        type: 'tool-call',
        toolCallId: 'call-incremental',
        toolName: 'Write',
        input: JSON.stringify(writeInput),
      },
      { type: 'tool-input-start', id: 'call-atomic', toolName: 'Ping' },
      { type: 'tool-input-end', id: 'call-atomic' },
      { type: 'tool-call', toolCallId: 'call-atomic', toolName: 'Ping', input: '{}' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: ZERO_USAGE,
      },
    ]);
    await runModel(model, [
      writeTool((input) => {
        writeExecutions += 1;
        writeReceived = input;
      }),
      pingTool((input) => {
        pingExecutions += 1;
        pingReceived = input;
      }),
    ]);
    assert.equal(writeExecutions, 1);
    assert.equal(pingExecutions, 1);
    assert.deepEqual(writeReceived, writeInput);
    assert.deepEqual(pingReceived, {});
  });

  // B. THE CRITICAL REGRESSION CASE: a zero-delta call whose SDK-resolved
  // final `tool-call` carries a NON-EMPTY projected input must still not
  // execute with that value. Zero raw delta bytes for this id is itself the
  // proof that the provider supplied no arguments (see ai-sdk-backend.ts);
  // a divergent non-empty projection is never trusted, so this executes with
  // the canonical empty object -- which, against Notify's *required*
  // `message` field, fails schema validation and never reaches `impl`.
  test('a zero-delta sibling with a non-empty final projected input still executes zero times', async () => {
    let writeExecutions = 0;
    let notifyExecutions = 0;
    const writeInput = { path: 'notes.md', content: 'hello' };
    const model = twoStepModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call-incremental', toolName: 'Write' },
      { type: 'tool-input-delta', id: 'call-incremental', delta: JSON.stringify(writeInput) },
      { type: 'tool-input-end', id: 'call-incremental' },
      {
        type: 'tool-call',
        toolCallId: 'call-incremental',
        toolName: 'Write',
        input: JSON.stringify(writeInput),
      },
      // Zero tool-input-delta chunks for call-atomic, yet the SDK's own
      // resolved tool-call somehow carries a non-empty payload -- a stale
      // repair, a provider bug, or worse. It must never reach `impl`.
      { type: 'tool-input-start', id: 'call-atomic', toolName: 'Notify' },
      { type: 'tool-input-end', id: 'call-atomic' },
      {
        type: 'tool-call',
        toolCallId: 'call-atomic',
        toolName: 'Notify',
        input: JSON.stringify({ message: 'done' }),
      },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: ZERO_USAGE,
      },
    ]);
    await runModel(model, [
      writeTool(() => {
        writeExecutions += 1;
      }),
      notifyTool(() => {
        notifyExecutions += 1;
      }),
    ]).catch(() => []);
    assert.equal(writeExecutions, 1);
    assert.equal(notifyExecutions, 0);
  });

  // C. Name substitution under a zero-delta, canonically-empty call is still
  // rejected -- isolated from case B by using an empty projected input here,
  // so this test fails only on identity, never on argument content.
  test('a zero-delta sibling whose final name disagrees with its own observed start is still rejected', async () => {
    let writeExecutions = 0;
    let notifyExecutions = 0;
    let shellExecutions = 0;
    const writeInput = { path: 'notes.md', content: 'hello' };
    const model = twoStepModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call-incremental', toolName: 'Write' },
      { type: 'tool-input-delta', id: 'call-incremental', delta: JSON.stringify(writeInput) },
      { type: 'tool-input-end', id: 'call-incremental' },
      {
        type: 'tool-call',
        toolCallId: 'call-incremental',
        toolName: 'Write',
        input: JSON.stringify(writeInput),
      },
      // Observed as "Notify" with zero deltas, but the AI SDK resolves the
      // same id under a DIFFERENT tool name. The guard's own observed name
      // for this id must still win — exactly like the raw-byte proof case
      // below — never the SDK's post-hoc projection under either name.
      { type: 'tool-input-start', id: 'call-atomic', toolName: 'Notify' },
      { type: 'tool-input-end', id: 'call-atomic' },
      { type: 'tool-call', toolCallId: 'call-atomic', toolName: 'Shell', input: '{}' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: ZERO_USAGE,
      },
    ]);
    await runModel(model, [
      writeTool(() => {
        writeExecutions += 1;
      }),
      notifyTool(() => {
        notifyExecutions += 1;
      }),
      shellTool(() => {
        shellExecutions += 1;
      }),
    ]).catch(() => []);
    assert.equal(writeExecutions, 1);
    assert.equal(notifyExecutions, 0);
    assert.equal(shellExecutions, 0);
  });

  // D. Id substitution under a zero-delta, canonically-empty call is still
  // rejected: the started id never got its own resolved tool-call, and the
  // resolved id never got its own start/end, so neither has an atomic proof
  // -- exactly the raw-byte proof's "call_1 evidence cannot authorize a
  // resolved call_2" shape, one level down.
  test('a zero-delta start/end pair cannot authorize a resolved call under a different id', async () => {
    let writeExecutions = 0;
    let pingExecutions = 0;
    const writeInput = { path: 'notes.md', content: 'hello' };
    const model = twoStepModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call-incremental', toolName: 'Write' },
      { type: 'tool-input-delta', id: 'call-incremental', delta: JSON.stringify(writeInput) },
      { type: 'tool-input-end', id: 'call-incremental' },
      {
        type: 'tool-call',
        toolCallId: 'call-incremental',
        toolName: 'Write',
        input: JSON.stringify(writeInput),
      },
      { type: 'tool-input-start', id: 'call-atomic-started', toolName: 'Ping' },
      { type: 'tool-input-end', id: 'call-atomic-started' },
      // Resolved under a different id than the one that streamed start/end.
      { type: 'tool-call', toolCallId: 'call-atomic-resolved', toolName: 'Ping', input: '{}' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: ZERO_USAGE,
      },
    ]);
    await runModel(model, [
      writeTool(() => {
        writeExecutions += 1;
      }),
      pingTool(() => {
        pingExecutions += 1;
      }),
    ]).catch(() => []);
    assert.equal(writeExecutions, 1);
    assert.equal(pingExecutions, 0);
  });

  // E. A zero-delta call missing its own tool-input-end (empty projected
  // input, so only the incomplete lifecycle -- not argument content -- is
  // under test here) is still rejected, even next to a proved sibling.
  test('a zero-delta sibling missing its own tool-input-end is still rejected, even next to a proved sibling', async () => {
    let writeExecutions = 0;
    let pingExecutions = 0;
    const writeInput = { path: 'notes.md', content: 'hello' };
    const model = twoStepModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call-incremental', toolName: 'Write' },
      { type: 'tool-input-delta', id: 'call-incremental', delta: JSON.stringify(writeInput) },
      { type: 'tool-input-end', id: 'call-incremental' },
      {
        type: 'tool-call',
        toolCallId: 'call-incremental',
        toolName: 'Write',
        input: JSON.stringify(writeInput),
      },
      // No tool-input-end for call-atomic at all: an incomplete lifecycle,
      // not a proof of atomicity.
      { type: 'tool-input-start', id: 'call-atomic', toolName: 'Ping' },
      { type: 'tool-call', toolCallId: 'call-atomic', toolName: 'Ping', input: '{}' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: ZERO_USAGE,
      },
    ]);
    await runModel(model, [
      writeTool(() => {
        writeExecutions += 1;
      }),
      pingTool(() => {
        pingExecutions += 1;
      }),
    ]).catch(() => []);
    assert.equal(writeExecutions, 1);
    assert.equal(pingExecutions, 0);
  });

  // F. A complete, unpoisoned zero-delta lifecycle next to an unsafe
  // terminal reason still executes zero times -- terminal safety gates the
  // atomic proof exactly like it gates the raw-byte proof.
  test('a zero-delta sibling is withheld when the physical request terminates unsafely', async () => {
    let writeExecutions = 0;
    let pingExecutions = 0;
    const writeInput = { path: 'notes.md', content: 'hello' };
    const model = twoStepModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call-incremental', toolName: 'Write' },
      { type: 'tool-input-delta', id: 'call-incremental', delta: JSON.stringify(writeInput) },
      { type: 'tool-input-end', id: 'call-incremental' },
      {
        type: 'tool-call',
        toolCallId: 'call-incremental',
        toolName: 'Write',
        input: JSON.stringify(writeInput),
      },
      { type: 'tool-input-start', id: 'call-atomic', toolName: 'Ping' },
      { type: 'tool-input-end', id: 'call-atomic' },
      { type: 'tool-call', toolCallId: 'call-atomic', toolName: 'Ping', input: '{}' },
      {
        type: 'finish',
        finishReason: { unified: 'length', raw: 'length' },
        usage: ZERO_USAGE,
      },
    ]);
    await runModel(model, [
      writeTool(() => {
        writeExecutions += 1;
      }),
      pingTool(() => {
        pingExecutions += 1;
      }),
    ]).catch(() => []);
    assert.equal(writeExecutions, 0);
    assert.equal(pingExecutions, 0);
  });

  // G. Composes with P1: a genuinely empty raw lifecycle, run through
  // ToolRuntime's own schema, reaches `impl` with the schema's declared
  // default filled in -- and the SDK's own (divergent, non-empty) projected
  // input is never what gets used, proving the atomic path never falls back
  // to `toolCall.input` even when a value happens to be available there.
  //
  // Mixed with a real incremental sibling on purpose: the per-call atomic
  // proof's canonical-empty-value rule is scoped to `hadRawArgumentEvidence`
  // being true (see ai-sdk-backend.ts) -- a genuinely whole-request-atomic
  // delivery is a separate, unchanged policy that trusts `toolCall.input`
  // directly, so this composition only exercises the new path with a
  // sibling that streamed real delta bytes.
  test('a zero-delta call composes with a schema default: the defaulted value reaches impl, never the divergent SDK projection', async () => {
    let writeExecutions = 0;
    let listTodosExecutions = 0;
    let listTodosReceived: unknown;
    const writeInput = { path: 'notes.md', content: 'hello' };
    const model = twoStepModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call-incremental', toolName: 'Write' },
      { type: 'tool-input-delta', id: 'call-incremental', delta: JSON.stringify(writeInput) },
      { type: 'tool-input-end', id: 'call-incremental' },
      {
        type: 'tool-call',
        toolCallId: 'call-incremental',
        toolName: 'Write',
        input: JSON.stringify(writeInput),
      },
      { type: 'tool-input-start', id: 'call-atomic', toolName: 'ListTodos' },
      { type: 'tool-input-end', id: 'call-atomic' },
      {
        type: 'tool-call',
        toolCallId: 'call-atomic',
        toolName: 'ListTodos',
        // Divergent from the canonical empty proof on purpose: must never
        // reach `impl`, whether or not it happens to satisfy the schema.
        input: JSON.stringify({ limit: 999 }),
      },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: ZERO_USAGE,
      },
    ]);
    await runModel(model, [
      writeTool(() => {
        writeExecutions += 1;
      }),
      listTodosTool((input) => {
        listTodosExecutions += 1;
        listTodosReceived = input;
      }),
    ]);
    assert.equal(writeExecutions, 1);
    assert.equal(listTodosExecutions, 1);
    assert.deepEqual(listTodosReceived, { limit: 10 });
  });

  test('proved Write identity cannot be substituted with Shell under the same id', async () => {
    let writeExecutions = 0;
    let shellExecutions = 0;
    const model = twoStepModel(
      toolCallChunks(
        'incremental',
        { unified: 'stop', raw: 'stop' },
        {
          rawToolName: 'Write',
          resolvedToolName: 'Shell',
          rawInput: { path: 'notes.md', content: 'hello' },
          projectedInput: { command: 'echo hi' },
        },
      ),
    );
    await runModel(model, [
      writeTool(() => {
        writeExecutions += 1;
      }),
      shellTool(() => {
        shellExecutions += 1;
      }),
    ]).catch(() => []);
    assert.equal(writeExecutions, 0);
    assert.equal(shellExecutions, 0);
  });

  test('ToolRuntime receives the raw-proved object, never divergent projected input', async () => {
    let receivedInput: unknown;
    let executions = 0;
    const model = twoStepModel(
      toolCallChunks(
        'incremental',
        { unified: 'stop', raw: 'stop' },
        {
          rawInput: { path: 'safe.md', content: 'hello' },
          projectedInput: { path: 'evil.md', content: 'hello' },
        },
      ),
    );
    await runModel(model, [
      writeTool((input) => {
        executions += 1;
        receivedInput = input;
      }),
    ]);
    assert.equal(executions, 1);
    assert.deepEqual(receivedInput, { path: 'safe.md', content: 'hello' });
  });

  // P1: the schema's own output (defaults filled in) must reach `impl`, and
  // it must be derived from the guard's raw-proved value, never the SDK's
  // divergent projected input — the two security properties compose.
  test('a schema default is applied on top of the raw-proved value, never the divergent SDK projection', async () => {
    let receivedInput: unknown;
    let executions = 0;
    const model = twoStepModel(
      toolCallChunks(
        'incremental',
        { unified: 'stop', raw: 'stop' },
        {
          rawInput: { path: 'safe.md' },
          projectedInput: { path: 'evil.md', content: 'untrusted' },
        },
      ),
    );
    const tool: MakaTool = {
      name: 'Write',
      description: 'Write file contents',
      parameters: z.object({
        path: z.string(),
        content: z.string().default('placeholder'),
      }),
      impl: async (input) => {
        executions += 1;
        receivedInput = input;
        return { ok: true };
      },
    };
    await runModel(model, [tool]);
    assert.equal(executions, 1);
    assert.deepEqual(receivedInput, { path: 'safe.md', content: 'placeholder' });
  });

  // P1 CASE E: structurally valid JSON that the tool's own schema rejects
  // (a required field is missing) must never reach `impl`, through the full
  // production dispatch chain — not just at the ToolRuntime unit level.
  test('raw-proved arguments that fail the declared schema execute zero times', async () => {
    let executions = 0;
    const model = twoStepModel(
      toolCallChunks(
        'incremental',
        { unified: 'stop', raw: 'stop' },
        { rawInput: { path: 'notes.md' } },
      ),
    );
    await runModel(model, [
      writeTool(() => {
        executions += 1;
      }),
    ]).catch(() => []);
    assert.equal(executions, 0);
  });

  test('matching id/name/value executes exactly once with the proved object', async () => {
    let receivedInput: unknown;
    let executions = 0;
    const model = twoStepModel(
      toolCallChunks(
        'incremental',
        { unified: 'stop', raw: 'stop' },
        {
          rawInput: { path: 'notes.md', content: 'hello' },
        },
      ),
    );
    await runModel(model, [
      writeTool((input) => {
        executions += 1;
        receivedInput = input;
      }),
    ]);
    assert.equal(executions, 1);
    assert.deepEqual(receivedInput, { path: 'notes.md', content: 'hello' });
  });
});
