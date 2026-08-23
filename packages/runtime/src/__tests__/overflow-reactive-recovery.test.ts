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
import { setImmediate as flushMacrotask } from 'node:timers/promises';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { z } from 'zod';
import type { ModelCallCommit } from '@maka/core/agent-run';
import { decodeModelCallAttempt, type ModelCallAttempt } from '@maka/core/model-call-attempt';
import { AiSdkBackend } from '../ai-sdk-backend.js';
import {
  LATEST_CONTEXT_PROJECTION_TYPE,
  readLatestContextSnapshot,
} from '../latest-context-snapshot.js';
import { createSessionEventMapMemory, mapSessionEventToRuntimeEvent } from '../ai-sdk-flow.js';
import type { InvocationContext } from '../invocation-context.js';
import {
  buildHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
  type HistoryCompactProviderState,
} from '../history-compact-checkpoint.js';
import {
  createTestAiSdkBackend,
  testToolResultArchive,
} from './execution-boundary-test-helpers.js';

// The checkpoint write gate validates summary structure and floors the size
// for large folds (#3029), so the stub summary is shaped like a real
// checkpoint and padded proportionally to the span it replaces.
function reactiveStructuredSummary(foldedRuntimeEvents: RuntimeEvent[]): string {
  const progress =
    JSON.stringify(foldedRuntimeEvents).length > 30_000 ? `- ${'covered '.repeat(150)}` : '- done';
  return `## Goal\nREACTIVE_SUMMARY_SENTINEL\n\n## Progress\n${progress}\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)`;
}

const RAW_SPAN_ONE = 'RAW_SPAN_ONE_'.repeat(24);
const ANCHOR_TEXT = 'reactive overflow recovery keep my exact words';
const OVERFLOW_MESSAGE = 'prompt is too long: 213462 tokens > 200000 maximum';

/**
 * Per-provider-request script. Each entry drives one `doStream` invocation:
 *  - 'tool'     → a Read tool call (completes a step, appends a durable pair)
 *  - 'bigtool'  → assistant text (sentinel) + a Read with a huge result, so the
 *                 proactive capacity trigger fires at this step's boundary
 *  - 'bigread'  → a pure Read with a huge result and NO step text, so the
 *                 durable pair is the trailing span a recovery fold must keep
 *                 verbatim in the tail (the prune-resurrection shape)
 *  - 'load'     → a `load_tools` call activating the gated 'big' group
 *  - 'gated'    → a call to the gated `Big` tool
 *  - 'done'     → final assistant text, finish stop
 *  - 'overflow' → the provider rejects with a context-length 400 (doStream
 *                 throws; the SDK surfaces it as a stream error chunk and
 *                 rejects finishReason — the fake-end_turn latent-bug path)
 *  - 'overflowPart' → OpenAI CHAT in-stream failure exactly as the locked
 *                 provider transform produces it: the error part value is the
 *                 INNER parsed error object (never an Error instance) and the
 *                 flush trailer is a finish part with finishReason 'error'
 *                 (openai-chat-language-model.ts:478-479 + flush) — the
 *                 round-8 P1-1 end-to-end shape
 *  - 'overflowPartResponses' → OpenAI RESPONSES in-stream failure: the error
 *                 part value is the WHOLE {type:'error', error:{...}} chunk
 *                 and the flush trailer keeps finishReason 'other' (the
 *                 isErrorChunk branch never reassigns it) — locks recovery
 *                 against per-family trailer drift
 *  - 'toolThenOverflowPart' → a tool call followed by an in-stream context
 *                 error before the request completes
 *  - 'error400' → a non-overflow, non-retryable provider failure
 *  - 'error500' → a retryable provider-unavailable failure
 *  - 'rateLimit' → a retryable rate-limit failure
 *  - 'terminated' → the provider transport dies before returning authoritative
 *                 usage for the current request
 *  - 'terminatedMidBody' → the response starts, then its body errors while the
 *                 SDK iterator is being consumed
 *  - 'partialThenTerminated' → visible text arrives before the body errors
 *  - 'partialThenOverflowPart' → visible text arrives before an in-stream
 *                 context error
 */
type CallKind =
  | 'tool'
  | 'bigtool'
  | 'bigread'
  | 'load'
  | 'gated'
  | 'done'
  | 'overflow'
  | 'overflow503'
  | 'overflowPart'
  | 'overflowPartResponses'
  | 'toolThenOverflowPart'
  | 'error400'
  | 'error500'
  | 'rateLimit'
  | 'terminated'
  | 'terminatedMidBody'
  | 'partialThenTerminated'
  | 'partialThenOverflowPart';

const RETRY_STEP_TEXT_SENTINEL = 'RETRY_STEP_TEXT_SENTINEL reasoning before the big read';
const BIG_RESULT = 'BIG_RESULT_'.repeat(200);

interface ReactiveFixtureOptions {
  script: CallKind[];
  contextWindow?: number;
  reserveTokens?: number;
  midTurnEnabled?: boolean;
  withoutPriorTurns?: boolean;
  bigPriors?: boolean;
  /** Add one hydrated historical image that fits the proactive capacity estimate. */
  imagePrior?: boolean;
  /** Put one image attachment on the durable current-turn user anchor. */
  currentImage?: boolean;
  /** Make Read return a newly produced image during this turn. */
  liveImageResult?: boolean;
  summarize?: () =>
    | Promise<string | HistoryCompactProviderState | undefined>
    | string
    | HistoryCompactProviderState
    | undefined;
  /** Return and replay a Codex subscription V2 provider checkpoint. */
  providerNative?: boolean;
  /** Explicit send-level step budget forwarded to the backend. */
  maxSteps?: number;
  /** The FIRST tool step reports an unusable usage object (no token counts). */
  firstStepUsageMissing?: boolean;
  /** Economy tool availability with the gated `Big` tool behind `load_tools`. */
  gatedToolGroup?: boolean;
  /**
   * appendMessage yields several macrotasks before resolving, so the durable
   * consumer genuinely lags while the Runtime loop advances toward its next
   * request projection — the P1-A race window.
   */
  slowAppendMessage?: boolean;
  /** Enable the active tool-result prune with a small threshold + archive seam. */
  activeToolResultPrune?: boolean;
  /** Test-only gate before a numbered provider request starts. */
  beforeStream?: (call: number) => Promise<void>;
  /** Test-only replacement for the Runtime-owned retry clock. */
  providerRetrySleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Override the stream idle watchdog for retry-wait coordination tests. */
  streamIdleTimeoutMs?: number;
  /**
   * Wire the canonical metering sink, so the fixture collects the commits a
   * settled request produces. Off by default: it is the accounting path, and
   * the recovery tests around it assert provider behaviour, not billing.
   */
  canonicalAccounting?: boolean;
  /**
   * A durable checkpoint the session already holds, served through the loader
   * seam exactly as the kernel serves one written by an earlier turn. Read at
   * send time, so a test can build it from the fixture's own prior events.
   */
  loadCheckpoint?: () => HistoryCompactCheckpoint | undefined;
}

interface ReactiveLlmCall {
  status?: string;
  errorClass?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface ReactiveFixture {
  backend: AiSdkBackend;
  model: MockLanguageModelV4;
  recorded: HistoryCompactCheckpoint[];
  toolExecutions: string[];
  summarizerCalls: () => number;
  anchor: RuntimeEvent;
  priorEvents: RuntimeEvent[];
  events: SessionEvent[];
  llmCalls: ReactiveLlmCall[];
  /** Canonical settlements, whole, when `canonicalAccounting` is on. */
  commits: ModelCallCommit<ModelCallAttempt>[];
  retryDelays: number[];
  /** JSON of each summarizer call's folded runtime events (coverage evidence). */
  summarizedSources: string[];
  persist: (event: SessionEvent) => void;
}

function buildReactiveFixture(options: ReactiveFixtureOptions): ReactiveFixture {
  const contextWindow = options.contextWindow ?? 200_000;
  const reserveTokens = options.reserveTokens ?? 1_000;
  const recorded: HistoryCompactCheckpoint[] = [];
  const commits: ModelCallCommit<ModelCallAttempt>[] = [];
  const toolExecutions: string[] = [];
  const events: SessionEvent[] = [];
  const llmCalls: ReactiveLlmCall[] = [];
  const retryDelays: number[] = [];
  const counters = { summarizerCalls: 0 };
  const usage = (input: number, output: number) => ({
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  });
  const toolCallChunks = (
    call: number,
    toolName: string,
    args: object,
    leadingText?: string,
  ): LanguageModelV4StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    ...(leadingText
      ? ([
          { type: 'text-start', id: `step-text-${call}` },
          { type: 'text-delta', id: `step-text-${call}`, delta: leadingText },
          { type: 'text-end', id: `step-text-${call}` },
        ] satisfies LanguageModelV4StreamPart[])
      : []),
    { type: 'tool-call', toolCallId: `tool-${call}`, toolName, input: JSON.stringify(args) },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      // An unusable first-step usage: the SDK accepts the object but the
      // adapter's normalization fails closed (undefined), the #972 shape.
      usage:
        options.firstStepUsageMissing && call === 1
          ? ({ inputTokens: {}, outputTokens: {} } as ReturnType<typeof usage>)
          : usage(100, 20),
    },
  ];
  const doneChunks = (): LanguageModelV4StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'done' },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(120, 10) },
  ];
  const streamForCall = (call: number): ReadableStream<LanguageModelV4StreamPart> => {
    const kind = options.script[call - 1];
    if (kind === 'overflow') {
      throw Object.assign(new Error(OVERFLOW_MESSAGE), {
        name: 'AI_APICallError',
        statusCode: 400,
      });
    }
    if (kind === 'overflow503') {
      throw Object.assign(new Error(OVERFLOW_MESSAGE), {
        name: 'AI_APICallError',
        statusCode: 503,
      });
    }
    if (kind === 'error500') {
      throw Object.assign(new Error('internal server error'), {
        name: 'AI_APICallError',
        statusCode: 500,
      });
    }
    if (kind === 'error400') {
      throw Object.assign(new Error('bad request'), {
        name: 'AI_APICallError',
        statusCode: 400,
      });
    }
    if (kind === 'rateLimit') {
      throw Object.assign(new Error('too many requests'), {
        name: 'AI_APICallError',
        statusCode: 429,
        responseHeaders: { 'retry-after-ms': '1' },
      });
    }
    if (kind === 'terminated') {
      throw new TypeError('terminated');
    }
    if (kind === 'terminatedMidBody') {
      return new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.error(new TypeError('terminated'));
        },
      });
    }
    if (kind === 'partialThenTerminated') {
      return new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 'partial-text' });
          controller.enqueue({ type: 'text-delta', id: 'partial-text', delta: 'partial' });
          setTimeout(() => controller.error(new TypeError('terminated')), 0);
        },
      });
    }
    if (kind === 'partialThenOverflowPart') {
      return simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'partial-overflow' },
          { type: 'text-delta', id: 'partial-overflow', delta: 'partial' },
          {
            type: 'error',
            error: {
              message: 'Bad Request',
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
            },
          },
          {
            type: 'finish',
            finishReason: { unified: 'error', raw: undefined },
            usage: usage(0, 0),
          },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      });
    }
    if (
      kind === 'overflowPart' ||
      kind === 'overflowPartResponses' ||
      kind === 'toolThenOverflowPart'
    ) {
      // The 200 response starts streaming, then the provider sends the error
      // inside the SSE stream. Each shape below is exactly what the locked
      // provider transform enqueues — no cross-family mixing:
      // Chat forwards the INNER error object and its flush emits a finish
      // part with finishReason 'error'; Responses forwards the WHOLE error
      // chunk and its flush keeps the initial finishReason 'other'.
      const errorValue =
        kind === 'overflowPart' || kind === 'toolThenOverflowPart'
          ? {
              message: 'Bad Request',
              type: 'invalid_request_error',
              param: null,
              code: 'context_length_exceeded',
            }
          : {
              type: 'error',
              sequence_number: 1,
              error: {
                type: 'invalid_request_error',
                code: 'context_length_exceeded',
                message: 'Bad Request',
                param: null,
              },
            };
      const trailerReason =
        kind === 'overflowPart'
          ? { unified: 'error' as const, raw: undefined }
          : { unified: 'other' as const, raw: undefined };
      return simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          ...(kind === 'toolThenOverflowPart'
            ? ([
                {
                  type: 'tool-call',
                  toolCallId: `tool-${call}`,
                  toolName: 'Read',
                  input: JSON.stringify({ path: 'one.md' }),
                },
              ] satisfies LanguageModelV4StreamPart[])
            : []),
          { type: 'error', error: errorValue },
          { type: 'finish', finishReason: trailerReason, usage: usage(0, 0) },
        ] satisfies LanguageModelV4StreamPart[],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      });
    }
    const chunks =
      kind === 'tool'
        ? toolCallChunks(call, 'Read', { path: 'one.md' })
        : kind === 'bigtool'
          ? toolCallChunks(call, 'Read', { path: 'big.md' }, RETRY_STEP_TEXT_SENTINEL)
          : kind === 'bigread'
            ? toolCallChunks(call, 'Read', { path: 'big.md' })
            : kind === 'load'
              ? toolCallChunks(call, 'load_tools', { group: 'big' })
              : kind === 'gated'
                ? toolCallChunks(call, 'Big', { q: 'run' })
                : doneChunks();
    return simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null });
  };
  const model = new MockLanguageModelV4({
    doStream: async (streamOptions: {
      abortSignal?: AbortSignal;
    }): Promise<{ stream: ReadableStream<LanguageModelV4StreamPart> }> => {
      await options.beforeStream?.(model.doStreamCalls.length);
      if (streamOptions.abortSignal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      return { stream: streamForCall(model.doStreamCalls.length) };
    },
  });

  const priorChars = options.bigPriors ? 4_000 : 120;
  const priorEvents: RuntimeEvent[] = options.withoutPriorTurns
    ? []
    : options.imagePrior
      ? [
          runtimeTextEvent('prior-user', 'turn-0', 'user', 'inspect the screenshot'),
          {
            ...runtimeTextEvent('prior-call', 'turn-0', 'model', ''),
            content: {
              kind: 'function_call' as const,
              id: 'prior-image-call',
              name: 'Read',
              args: { path: 'screenshot.png' },
            },
          },
          {
            ...runtimeTextEvent('prior-result', 'turn-0', 'model', ''),
            role: 'tool' as const,
            author: 'tool' as const,
            content: {
              kind: 'function_response' as const,
              id: 'prior-image-call',
              name: 'Read',
              result: {
                kind: 'image' as const,
                mimeType: 'image/png',
                ref: {
                  kind: 'session_file' as const,
                  sessionId: 'session-1',
                  relativePath: 'screenshot.png',
                },
              },
              isError: false,
            },
          },
          runtimeTextEvent('prior-model', 'turn-0', 'model', 'screenshot inspected'),
        ]
      : [
          runtimeTextEvent(
            'prior-user',
            'turn-0',
            'user',
            `PRIOR_FACT question ${'p'.repeat(priorChars)}`,
          ),
          runtimeTextEvent(
            'prior-model',
            'turn-0',
            'model',
            `PRIOR_FACT answer ${'q'.repeat(priorChars)}`,
          ),
        ];
  const anchor: RuntimeEvent = {
    ...runtimeTextEvent('anchor-1', 'turn-1', 'user', ANCHOR_TEXT),
    ...(options.currentImage
      ? {
          content: {
            kind: 'text' as const,
            text: ANCHOR_TEXT,
            attachments: [
              {
                kind: 'image' as const,
                name: 'current.png',
                mimeType: 'image/png',
                bytes: 8,
                ref: {
                  kind: 'session_file' as const,
                  sessionId: 'session-1',
                  relativePath: 'current.png',
                },
              },
            ],
          },
        }
      : {}),
  };

  const ledger: RuntimeEvent[] = [anchor];
  const ledgerCtx: InvocationContext = {
    sessionId: 'session-1',
    invocationId: 'run-1',
    runId: 'run-1',
    turnId: 'turn-1',
    source: 'desktop',
    startedAt: 1,
    request: { sessionId: 'session-1', turnId: 'turn-1', text: ANCHOR_TEXT, source: 'desktop' },
    newId: idGenerator(),
    now: monotonicClock(),
  };
  const ledgerMemory = createSessionEventMapMemory();
  const persist = (event: SessionEvent): void => {
    const mapped = mapSessionEventToRuntimeEvent(event, ledgerCtx, ledgerMemory);
    if (mapped.partial === true) return;
    if (mapped.content?.kind === 'error') return;
    ledger.push(mapped);
  };

  const midTurnEnabled = options.midTurnEnabled ?? true;
  const summarizedSources: string[] = [];
  const durableReader = {
    loadTurnRuntimeEvents: async (turnId: string) => {
      await flushMacrotask();
      return ledger.filter((event) => event.turnId === turnId);
    },
  };
  const compactionSeams = midTurnEnabled
    ? {
        summarizeHistoryCompact: async (input: {
          source: { foldedRuntimeEvents: RuntimeEvent[] };
        }) => {
          counters.summarizerCalls += 1;
          summarizedSources.push(JSON.stringify(input.source.foldedRuntimeEvents));
          return options.providerNative
            ? ({
                kind: 'openai_codex_remote_v2',
                connectionSlug: 'codex-subscription',
                modelId: 'mock-model-id',
                itemId: 'cmp_reactive',
                encryptedContent: 'REACTIVE_ENCRYPTED_STATE',
              } satisfies HistoryCompactProviderState)
            : options.summarize
              ? await options.summarize()
              : reactiveStructuredSummary(input.source.foldedRuntimeEvents);
        },
        recordHistoryCompactCheckpoint: (checkpoint: HistoryCompactCheckpoint) => {
          recorded.push(checkpoint);
        },
        allowMidTurnHistoryCompaction: true,
      }
    : {};

  const backend = createTestAiSdkBackend({
    sessionId: 'session-1',
    header: header(),
    appendMessage: async () => {
      if (!options.slowAppendMessage) return;
      for (let i = 0; i < 5; i += 1) await flushMacrotask();
    },
    connection: {
      ...connection(),
      ...(options.providerNative
        ? { slug: 'codex-subscription', providerType: 'openai-codex' as const }
        : {}),
      models: [{ id: 'mock-model-id', contextWindow }],
    },
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    ...(options.imagePrior || options.currentImage || options.liveImageResult
      ? {
          supportsVision: true,
          readAttachmentBytes: async () => ({
            ok: true as const,
            bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
          }),
        }
      : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    tools: [
      {
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        impl: async (args: { path: string }) => {
          toolExecutions.push(args.path);
          if (options.liveImageResult) {
            return {
              kind: 'image' as const,
              mimeType: 'image/png',
              ref: {
                kind: 'session_file' as const,
                sessionId: 'session-1',
                relativePath: 'live.png',
              },
            };
          }
          return { body: args.path === 'big.md' ? BIG_RESULT : RAW_SPAN_ONE };
        },
      },
      ...(options.gatedToolGroup
        ? [
            {
              name: 'Big',
              description: 'Gated capability behind the big group',
              parameters: z.object({ q: z.string() }),
              impl: async () => {
                toolExecutions.push('BIG_EXEC');
                return { ok: true };
              },
            },
          ]
        : []),
    ],
    ...(options.gatedToolGroup
      ? { toolAvailability: { economy: true, groups: [{ id: 'big', toolNames: ['Big'] }] } }
      : {}),
    contextBudget: {
      name: 'reactive-test',
      maxHistoryEstimatedTokens: 100_000,
      minRecentTurns: 1,
      historyCompact: {
        enabled: true,
        mode: 'read_write',
        ...(midTurnEnabled ? { midTurn: { enabled: true, reserveTokens } } : {}),
      },
      ...(options.activeToolResultPrune
        ? { activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 100 } }
        : {}),
    },
    ...(options.activeToolResultPrune
      ? {
          toolResultArchive: testToolResultArchive({
            archiveToolResult: () => ({ artifactId: 'artifact-archived-1' }),
          }),
        }
      : {}),
    ...durableReader,
    ...compactionSeams,
    ...(options.canonicalAccounting
      ? {
          recordModelCallAttempt: (commit: ModelCallCommit<ModelCallAttempt>) => {
            commits.push(commit);
          },
        }
      : {}),
    ...(options.loadCheckpoint
      ? { loadHistoryCompactCheckpoint: async () => options.loadCheckpoint!() }
      : {}),
    // The send-level record is gone (#1679); its diagnostics moved to the run
    // trace, which is what these assertions observe now.
    recordRunTrace: (event) => {
      if (event.type !== 'send_diagnostics_recorded') return;
      // Same fail-closed rule the send-level record enforced: a send with no
      // usable usage evidence produces no usage row at all (#972). The trace
      // still fires for its context diagnostics; only usage-bearing sends land
      // here.
      const data = event.data as (typeof llmCalls)[number] | undefined;
      if (data?.totalTokens === undefined) return;
      llmCalls.push(data);
    },
    providerRetrySleep: async (delayMs, signal) => {
      retryDelays.push(delayMs);
      await options.providerRetrySleep?.(delayMs, signal);
    },
    ...(options.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
      : {}),
    newId: idGenerator(),
    now: monotonicClock(),
  });

  return {
    backend,
    model,
    recorded,
    toolExecutions,
    summarizerCalls: () => counters.summarizerCalls,
    anchor,
    priorEvents,
    events,
    llmCalls,
    commits,
    retryDelays,
    summarizedSources,
    persist,
  };
}

async function runTurn(
  fixture: ReactiveFixture,
  consumer: 'immediate' | 'slow' = 'immediate',
  pullSteering?: () => Array<{ id: string; messageId: string; content: { text: string } }>,
): Promise<void> {
  for await (const event of fixture.backend.send({
    runId: 'run-1',
    turnId: 'turn-1',
    headAnchorRuntimeEvent: fixture.anchor,
    text: ANCHOR_TEXT,
    context: [],
    runtimeContext: [...fixture.priorEvents],
    ...(pullSteering ? { pullSteering } : {}),
  })) {
    if (consumer === 'slow') {
      // Scheduling perturbation (same as the mid-turn suite): hold the durable
      // write back across several macrotasks so the ledger genuinely lags the
      // SDK's step progression.
      await flushMacrotask();
      await flushMacrotask();
      await flushMacrotask();
    }
    // The consumer persists every non-partial event to the durable ledger,
    // exactly like AgentRun, so the reactive compaction pool can span the
    // completed steps.
    fixture.persist(event);
    fixture.events.push(event);
  }
}

/** The compaction each sealed row reports, in settlement order. */
function boundariesOf(commits: readonly ModelCallCommit<ModelCallAttempt>[]) {
  return commits.map(
    (commit) =>
      readLatestContextSnapshot({
        type: LATEST_CONTEXT_PROJECTION_TYPE,
        data: commit.latestContext?.snapshot,
      })?.compaction,
  );
}

function complete(
  fixture: ReactiveFixture,
): Extract<SessionEvent, { type: 'complete' }> | undefined {
  return fixture.events.find((event) => event.type === 'complete') as
    | Extract<SessionEvent, { type: 'complete' }>
    | undefined;
}

describe('reactive overflow recovery in the streaming backend', () => {
  test('a request-level context-length 400 ends as a real error, never a fake end_turn', async () => {
    // The latent bug: a provider that rejects the request (doStream throws) is
    // surfaced as a stream error chunk while finishReason rejects. The old
    // path caught that rejection as `stop` and emitted a CompleteEvent with
    // end_turn plus success telemetry — a silent fabrication. Without the
    // mid-turn seam there is nothing to recover, so the honest terminal is a
    // real error carrying the provider's classification.
    const fixture = buildReactiveFixture({ script: ['overflow'], midTurnEnabled: false });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 1);
    // Real error terminal, never a fabricated end_turn success.
    assert.equal(complete(fixture)?.stopReason, 'error');
    // A first-class error event carrying the overflow classification.
    const errorEvent = fixture.events.find((event) => event.type === 'error') as
      | Extract<SessionEvent, { type: 'error' }>
      | undefined;
    assert.equal(errorEvent !== undefined, true);
    assert.equal(errorEvent?.reason, 'context_overflow');
    // The old fake-success path emitted end_turn with success telemetry; the
    // fixed path never records this dead request as a successful call.
    assert.equal(
      fixture.llmCalls.some((call) => call.status === 'success'),
      false,
    );
  });

  test('a non-overflow provider failure ends as a real error without any recovery attempt', async () => {
    const fixture = buildReactiveFixture({ script: ['error400'], bigPriors: true });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 1);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      true,
    );
    // Not a context-length error → no compaction, no retry.
    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.summarizerCalls(), 0);
  });

  test('retries one provider-unavailable failure from the request boundary', async () => {
    const fixture = buildReactiveFixture({ script: ['error500', 'done'] });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.summarizerCalls(), 0);
  });

  test('retries one rate-limit failure from the request boundary', async () => {
    const fixture = buildReactiveFixture({ script: ['rateLimit', 'done'] });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    assert.deepEqual(fixture.retryDelays, [1]);
    assert.deepEqual(
      fixture.events
        .filter((event) => event.type === 'provider_retry')
        .map(({ phase, attempt, maxAttempts, reason }) => ({
          phase,
          attempt,
          maxAttempts,
          reason,
        })),
      [
        {
          phase: 'scheduled',
          attempt: 2,
          maxAttempts: 10,
          reason: 'rate_limit',
        },
        {
          phase: 'started',
          attempt: 2,
          maxAttempts: 10,
          reason: 'rate_limit',
        },
      ],
    );
  });

  test('applies a fresh provider retry budget to each completed step', async () => {
    const fixture = buildReactiveFixture({
      script: ['rateLimit', 'tool', 'rateLimit', 'done'],
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 4);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.deepEqual(fixture.toolExecutions, ['one.md']);
  });

  test('stops after ten provider attempts with bounded exponential backoff', async () => {
    const fixture = buildReactiveFixture({
      script: Array.from({ length: 10 }, () => 'error500'),
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 10);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(fixture.retryDelays.length, 9);
    const bases = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000, 32_000, 32_000];
    for (const [index, delay] of fixture.retryDelays.entries()) {
      const base = bases[index]!;
      assert.equal(delay >= base && delay <= base * 1.25, true);
    }
  });

  test('pauses the stream watchdog during an intentional provider backoff', async () => {
    const fixture = buildReactiveFixture({
      script: ['rateLimit', 'done'],
      streamIdleTimeoutMs: 5,
      providerRetrySleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
  });

  test('cancels a provider backoff when the turn is stopped', async () => {
    let retryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    const fixture = buildReactiveFixture({
      script: ['rateLimit', 'done'],
      providerRetrySleep: async (_delayMs, signal) => {
        retryStarted();
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        });
      },
    });

    const turn = runTurn(fixture);
    await started;
    await fixture.backend.stop('user_stop', 'immediate');
    await turn;

    assert.equal(fixture.model.doStreamCalls.length, 1);
    assert.equal(
      fixture.events.some((event) => event.type === 'abort' && event.reason === 'user_stop'),
      true,
    );
  });

  test('cancels a provider backoff when the event consumer detaches', async () => {
    let retryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      retryStarted = resolve;
    });
    let retrySleepAborted = false;
    const fixture = buildReactiveFixture({
      script: ['rateLimit', 'done'],
      providerRetrySleep: async (_delayMs, signal) => {
        retryStarted();
        await new Promise<void>((resolve, reject) => {
          const fallback = setTimeout(resolve, 50);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(fallback);
              retrySleepAborted = true;
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            },
            { once: true },
          );
        });
      },
    });
    const iterator = fixture.backend
      .send({
        runId: 'run-1',
        turnId: 'turn-1',
        headAnchorRuntimeEvent: fixture.anchor,
        text: ANCHOR_TEXT,
        context: [],
        runtimeContext: [...fixture.priorEvents],
      })
      [Symbol.asyncIterator]();

    const retryScheduled = await iterator.next();
    assert.equal(retryScheduled.value?.type, 'provider_retry');
    assert.equal(
      retryScheduled.value?.type === 'provider_retry' ? retryScheduled.value.phase : undefined,
      'scheduled',
    );
    await started;
    await iterator.return?.();

    assert.equal(retrySleepAborted, true);
    assert.equal(fixture.model.doStreamCalls.length, 1);
  });

  test('retries one transient transport failure from the completed-step request boundary', async () => {
    const fixture = buildReactiveFixture({ script: ['tool', 'terminated', 'done'] });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    assert.deepEqual(fixture.toolExecutions, ['one.md']);
    assert.equal(
      JSON.stringify(fixture.model.doStreamCalls[2]?.prompt).includes(RAW_SPAN_ONE),
      true,
    );
    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.summarizerCalls(), 0);
    // The dead provider request returned no authoritative usage. Recovery may
    // preserve effectiveness, but the send must remain unmetered rather than
    // presenting the successful retry's usage as the whole attempt.
    assert.equal(
      fixture.llmCalls.some((call) => call.totalTokens !== undefined),
      false,
    );
  });

  test('retries when a provider response body terminates during stream iteration', async () => {
    const fixture = buildReactiveFixture({ script: ['tool', 'terminatedMidBody', 'done'] });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    assert.deepEqual(fixture.toolExecutions, ['one.md']);
  });

  test('does not retry a terminated request after visible output was emitted', async () => {
    const fixture = buildReactiveFixture({ script: ['tool', 'partialThenTerminated', 'done'] });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(
      fixture.events.some((event) => event.type === 'text_delta' && event.text === 'partial'),
      true,
    );
  });

  test('surfaces the tenth transport failure without spending another sample', async () => {
    const fixture = buildReactiveFixture({
      script: ['tool', ...Array.from({ length: 10 }, () => 'terminated' as const)],
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 11);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.deepEqual(fixture.toolExecutions, ['one.md']);
    assert.equal(fixture.recorded.length, 0);
  });

  test('compacts once and retries after a mid-stream context-length overflow', async () => {
    // A tool step completes, then the provider rejects the second request with
    // a context-length 400 even though our proactive estimate stayed under the
    // window. Reactive recovery folds a safe completed prefix into a durable
    // mid_turn checkpoint and resends once; the retry succeeds and the turn
    // completes normally on the compacted projection.
    const fixture = buildReactiveFixture({ script: ['tool', 'overflow', 'done'], bigPriors: true });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    // Exactly one recovery compaction happened, tagged as an overflow trigger.
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]!.phase, 'mid_turn');
    assert.equal(fixture.summarizerCalls(), 1);
    // The completed tool step was not re-executed on the retry.
    assert.deepEqual(fixture.toolExecutions, ['one.md']);
    // Send-level usage owner (review P1-2): the terminal record carries BOTH
    // attempts' completed steps — the first attempt's tool step (100/20) plus
    // the retry's final step (120/10) — not just the last attempt's cumulative usage.
    const lastCall = fixture.llmCalls.at(-1);
    assert.equal(lastCall?.status, 'success');
    assert.equal(lastCall?.inputTokens, 220);
    assert.equal(lastCall?.outputTokens, 30);
    assert.equal(lastCall?.totalTokens, 250);
  });

  test('drops hydrated images before the single overflow retry without rerunning tools', async () => {
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow', 'done'],
      imagePrior: true,
      currentImage: true,
      liveImageResult: true,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.deepEqual(fixture.toolExecutions, ['one.md']);
    assert.equal(fixture.summarizerCalls(), 0);
    assert.equal(fixture.recorded.length, 0);

    const rejectedPrompt = JSON.stringify(fixture.model.doStreamCalls[1]?.prompt);
    const retryPrompt = JSON.stringify(fixture.model.doStreamCalls[2]?.prompt);
    assert.equal(rejectedPrompt.match(/"mediaType":"image\/png"/g)?.length, 3);
    assert.equal(retryPrompt.match(/"mediaType":"image\/png"/g)?.length, 2);
    assert.match(
      retryPrompt,
      /Image artifact \\"screenshot\.png\\" omitted after provider context overflow/,
    );
  });

  test('surfaces a retryable second overflow after the image-only retry without another loop', async () => {
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow503', 'overflow503'],
      imagePrior: true,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.deepEqual(fixture.toolExecutions, ['one.md']);
    assert.equal(fixture.summarizerCalls(), 0);
    assert.equal(fixture.recorded.length, 0);
  });

  test('keeps only the historical image omitted after the overflow retry returns a tool call', async () => {
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow', 'tool', 'done'],
      imagePrior: true,
      currentImage: true,
      liveImageResult: true,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 4);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.summarizerCalls(), 0);
    const expectedImages = [2, 3];
    for (const [index, call] of fixture.model.doStreamCalls.slice(2).entries()) {
      const prompt = JSON.stringify(call.prompt);
      assert.equal(prompt.match(/"mediaType":"image\/png"/g)?.length, expectedImages[index]);
      assert.match(
        prompt,
        /Image artifact \\"screenshot\.png\\" omitted after provider context overflow/,
      );
    }
  });

  test('keeps a step-0 overflow checkpoint projected after the retry returns a tool call', async () => {
    // The first request overflows before any step completes. Recovery folds
    // only prior history into a pre-turn checkpoint and retries with the
    // current user anchor verbatim. When that retry returns a tool call, the
    // next request must rebuild from raw durable events through the checkpoint
    // boundary instead of resurrecting the cached raw prior replay.
    const fixture = buildReactiveFixture({ script: ['overflow', 'tool', 'done'], bigPriors: true });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]!.phase, undefined);
    assert.equal(fixture.summarizerCalls(), 1);
    assert.deepEqual(fixture.toolExecutions, ['one.md']);

    const retryPrompt = JSON.stringify(fixture.model.doStreamCalls[1]?.prompt);
    const successorPrompt = JSON.stringify(fixture.model.doStreamCalls[2]?.prompt);
    for (const prompt of [retryPrompt, successorPrompt]) {
      assert.equal(prompt.includes('REACTIVE_SUMMARY_SENTINEL'), true);
      assert.equal(prompt.includes(ANCHOR_TEXT), true);
      assert.equal(prompt.includes('PRIOR_FACT'), false);
    }
    assert.equal(successorPrompt.includes(RAW_SPAN_ONE), true);
  });

  test('the resend seals the fold recovery made for it, and the request before it seals none', async () => {
    // Recovery is the other place the boundary moves between two dispatches of
    // one send, and the harder one: the fold happens after a request was
    // already built, dispatched and rejected. The rejected request settles no
    // sealed row (it never completed), and the resend must report the fold it
    // was rebuilt from rather than the state the send started in (#2323).
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow', 'done'],
      bigPriors: true,
      canonicalAccounting: true,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(fixture.recorded.length, 1);
    const checkpoint = fixture.recorded[0]!;
    assert.equal(checkpoint.phase, 'mid_turn');

    const sealed = fixture.commits.filter((commit) => commit.latestContext !== undefined);
    assert.equal(sealed.length, 2, 'the rejected request seals nothing; the other two do');
    for (const commit of sealed) {
      const attempt = decodeModelCallAttempt(commit.attempt);
      assert.equal(attempt.callKind, 'main');
      assert.equal(attempt.status, 'completed');
    }
    assert.deepEqual(boundariesOf(sealed), [
      undefined,
      {
        kind: 'history',
        phase: 'mid_turn',
        eventCount: checkpoint.coverage.eventCount,
        turnCount: checkpoint.coverage.turnCount,
        estimatedTokens: checkpoint.estimatedTokens,
      },
    ]);
  });

  test('a checkpoint carried in from an earlier turn is the boundary of a send that folds nothing', async () => {
    // The ordinary case, and the only one where the boundary comes from the
    // pre-turn projection rather than from mid-turn state: nothing compacts
    // during this send, so what the prompt stands on is what the session
    // carried into it.
    let carried: HistoryCompactCheckpoint | undefined;
    const fixture = buildReactiveFixture({
      script: ['done'],
      midTurnEnabled: false,
      canonicalAccounting: true,
      // Large enough that folding them is a real saving: the replay refuses a
      // checkpoint that would not shrink the history it replaces.
      bigPriors: true,
      loadCheckpoint: () => carried,
    });
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: fixture.priorEvents,
      summary: 'EARLIER_TURN_SUMMARY',
      summaryFormat: 'legacy_freeform',
    });
    carried = checkpoint;
    await runTurn(fixture);

    const prompt = JSON.stringify(fixture.model.doStreamCalls[0]?.prompt);
    assert.equal(prompt.includes('EARLIER_TURN_SUMMARY'), true, 'the fold is in the prompt');
    assert.equal(prompt.includes('PRIOR_FACT'), false, 'and the raw prefix it replaced is not');
    assert.deepEqual(boundariesOf(fixture.commits), [
      {
        kind: 'history',
        phase: 'pre_turn',
        eventCount: checkpoint.coverage.eventCount,
        turnCount: checkpoint.coverage.turnCount,
        estimatedTokens: checkpoint.estimatedTokens,
      },
    ]);
  });

  test('a loaded checkpoint the projection refused is not reported as the boundary', async () => {
    // The difference between the checkpoint a session HOLDS and the one a
    // prompt was BUILT from. This one covers an event the ledger does not
    // have, so the prefix match fails and the replay keeps the raw prior
    // history — reporting it would describe a fold the request never had.
    const foreign = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [
        runtimeTextEvent('never-happened', 'turn-x', 'user', 'AN EVENT THIS LEDGER NEVER HELD'),
      ],
      summary: 'SUMMARY_OF_ANOTHER_HISTORY',
      summaryFormat: 'legacy_freeform',
    });
    const fixture = buildReactiveFixture({
      script: ['done'],
      midTurnEnabled: false,
      canonicalAccounting: true,
      // Same priors as the accepted case above, so the refusal can only be the
      // coverage miss and not a fold that failed to pay for itself.
      bigPriors: true,
      loadCheckpoint: () => foreign,
    });
    await runTurn(fixture);

    const prompt = JSON.stringify(fixture.model.doStreamCalls[0]?.prompt);
    assert.equal(prompt.includes('SUMMARY_OF_ANOTHER_HISTORY'), false, 'the fold was refused');
    assert.equal(prompt.includes('PRIOR_FACT'), true, 'so the raw history is what was sent');
    assert.deepEqual(boundariesOf(fixture.commits), [undefined]);
  });

  test('a step-0 recovery fold is sealed as pre_turn by the request it rebuilt', async () => {
    // The same seam with the other phase, and the only path that reaches a
    // pre-turn boundary without a prior turn having written one: nothing had
    // completed when the provider rejected, so recovery folds prior history
    // alone and both later requests were built under that one boundary.
    const fixture = buildReactiveFixture({
      script: ['overflow', 'tool', 'done'],
      bigPriors: true,
      canonicalAccounting: true,
    });
    await runTurn(fixture);

    assert.equal(fixture.recorded.length, 1);
    const checkpoint = fixture.recorded[0]!;
    assert.equal(checkpoint.phase, undefined, 'a step-0 fold carries no mid_turn phase');

    const preTurn = {
      kind: 'history',
      phase: 'pre_turn',
      eventCount: checkpoint.coverage.eventCount,
      turnCount: checkpoint.coverage.turnCount,
      estimatedTokens: checkpoint.estimatedTokens,
    };
    assert.deepEqual(
      boundariesOf(fixture.commits.filter((commit) => commit.latestContext !== undefined)),
      [preTurn, preTurn],
      'the retry and its successor were both built under the recovery fold',
    );
  });

  test('keeps native Codex state projected across a step-0 overflow retry', async () => {
    const fixture = buildReactiveFixture({
      script: ['overflow', 'tool', 'done'],
      bigPriors: true,
      providerNative: true,
    });
    await runTurn(fixture);

    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.recorded[0]?.version, 3);
    for (const call of [1, 2]) {
      const prompt = JSON.stringify(fixture.model.doStreamCalls[call]?.prompt);
      assert.match(prompt, /REACTIVE_ENCRYPTED_STATE/);
      assert.match(prompt, /cmp_reactive/);
      assert.doesNotMatch(prompt, /Provider-native OpenAI Codex compaction checkpoint/);
      assert.doesNotMatch(prompt, /PRIOR_FACT/);
      assert.match(prompt, new RegExp(ANCHOR_TEXT));
    }
  });

  test('does not retry an overflow after an after-step stop is requested', async () => {
    let signalSecondStream!: () => void;
    let releaseSecondStream!: () => void;
    const secondStreamStarted = new Promise<void>((resolve) => {
      signalSecondStream = resolve;
    });
    const secondStreamGate = new Promise<void>((resolve) => {
      releaseSecondStream = resolve;
    });
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow', 'done'],
      bigPriors: true,
      beforeStream: async (call) => {
        if (call !== 2) return;
        signalSecondStream();
        await secondStreamGate;
      },
    });

    const turn = runTurn(fixture);
    await secondStreamStarted;
    await fixture.backend.stop('user_stop', 'after_step');
    releaseSecondStream();
    await turn;

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(fixture.recorded.length, 0);
  });

  test('recovers from a plain-object in-stream error part, not just Error instances (review round-8 P1-1)', async () => {
    // Providers deliver in-stream failures as parsed plain objects (or bare
    // strings), never Error instances. The recovery decision must classify
    // the real shape; an instanceof Error gate silently downgraded every
    // genuine in-stream overflow to an unrecoverable terminal error.
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflowPart', 'done'],
      bigPriors: true,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]!.phase, 'mid_turn');
  });

  test('recovers from the Responses-family in-stream error shape with its non-error finish trailer (review round-9 P3)', async () => {
    // Same failure, different family: the error part value is the WHOLE
    // {type:'error', error:{...}} chunk and the trailer finish keeps
    // finishReason 'other'. The recovery decision truncates at the error part,
    // so trailer drift across provider families must not change the outcome.
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflowPartResponses', 'done'],
      bigPriors: true,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]!.phase, 'mid_turn');
  });

  test('does not recover an overflow after the failed stream emitted a tool call', async () => {
    const fixture = buildReactiveFixture({
      script: ['tool', 'toolThenOverflowPart', 'done'],
      bigPriors: true,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.deepEqual(fixture.toolExecutions, ['one.md']);
    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.summarizerCalls(), 0);
  });

  test('does not recover an overflow after the failed stream emitted visible text', async () => {
    const fixture = buildReactiveFixture({
      script: ['tool', 'partialThenOverflowPart', 'done'],
      bigPriors: true,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(fixture.recorded.length, 0);
    assert.equal(
      fixture.events.some((event) => event.type === 'text_delta' && event.text === 'partial'),
      true,
    );
  });

  test('a transport retry after overflow keeps the recovered request projection', async () => {
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow', 'terminated', 'done'],
      bigPriors: true,
    });
    await runTurn(fixture);

    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.model.doStreamCalls.length, 4);
    assert.deepEqual(
      fixture.model.doStreamCalls[3]?.prompt,
      fixture.model.doStreamCalls[2]?.prompt,
    );
  });

  test('the recovery baseline is the request the provider rejected, not the attempt-initial messages', async () => {
    // Review P1-1 repro: four completed tool steps grow the provider-visible
    // request far beyond the attempt's INITIAL messages. The fold shrinks the
    // real rejected request but is larger than that initial request, so a
    // baseline anchored to the initial messages refuses it as
    // replacement_not_smaller and the turn dies on the exact scenario reactive
    // recovery exists for — same-turn tool growth. The unique baseline owner
    // is the verdict owner's per-request payload measure of the request that
    // actually went out.
    const fixture = buildReactiveFixture({
      script: ['tool', 'tool', 'tool', 'tool', 'overflow', 'done'],
    });
    await runTurn(fixture);

    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.model.doStreamCalls.length, 6);
    // The four completed tool steps ran exactly once each.
    assert.deepEqual(fixture.toolExecutions, ['one.md', 'one.md', 'one.md', 'one.md']);
  });

  test('an unusable first-attempt step usage fails the whole record closed even when the retry succeeds', async () => {
    // Review P1-2, fail-closed direction: the first attempt's completed step
    // has an unusable usage sample. The retry's cumulative usage is valid but covers
    // only the retry, so recording it as the whole send would fabricate a
    // partial cost as complete (#972). No record at all is the truthful
    // outcome; the turn itself still completes.
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow', 'done'],
      bigPriors: true,
      firstStepUsageMissing: true,
    });
    await runTurn(fixture);

    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.llmCalls.length, 0);
  });

  test('the Runtime send-level step limit survives an explicit overflow retry (review P1-3)', async () => {
    // maxSteps=2: one completed tool step before the overflow leaves exactly
    // one Runtime-owned step. The retry consumes it and the send ends at the
    // explicit limit; no adapter-local budget is involved.
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow', 'tool', 'done'],
      bigPriors: true,
      maxSteps: 2,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.deepEqual(fixture.toolExecutions, ['one.md', 'one.md']);
    assert.equal(complete(fixture)?.stopReason, 'step_limit');
  });

  test("a completed retry step's assistant text is never dropped by a post-retry compaction (review P1-A)", async () => {
    // Review round-2 P1-A repro: provider request boundaries and the Runtime's
    // flushedSteps / replacedStepNumber / lastShapeFailure are send-level.
    // After a retry, a mismatched request-local boundary could satisfy the
    // durability wait before the retry step's text_complete is durable, and
    // because the
    // replacement projection replaces the whole message list, that streamed
    // assistant text silently vanishes from both the covered span and the
    // preserved tail. Same shape as PR 1's finding B, re-opened across the
    // attempt boundary. The lag lever is a slow appendMessage: the pump gets
    // stuck INSIDE flushStep (text_complete not yet enqueued, flushedSteps not
    // yet incremented) while the immediate consumer has drained everything
    // already pushed — so `consumed >= pushed` holds and only the send-global
    // flushedSteps bound can still hold the ledger read back.
    const fixture = buildReactiveFixture({
      // High water 400: the first attempt's boundary (~usage 100 + small
      // delta) stays under it, the retry step's huge result (~BIG_RESULT/4)
      // crosses it, so the capacity trigger fires exactly at the retry's own
      // step boundary.
      script: ['tool', 'overflow', 'bigtool', 'done'],
      bigPriors: true,
      contextWindow: 2_000,
      reserveTokens: 1_600,
      slowAppendMessage: true,
    });
    await runTurn(fixture);

    // The turn completes on the compacted projections (recovery fold + the
    // post-retry capacity fold), with the retry's step text streamed out.
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some(
        (event) =>
          event.type === 'text_complete' && event.text.includes('RETRY_STEP_TEXT_SENTINEL'),
      ),
      true,
    );
    // The projection accounts for that text: it survives either verbatim in
    // the final request or inside a summarized covered span — never silently
    // dropped from both.
    const finalPrompt = JSON.stringify(fixture.model.doStreamCalls.at(-1)?.prompt);
    const inTail = finalPrompt.includes('RETRY_STEP_TEXT_SENTINEL');
    const inCoveredSpan = fixture.summarizedSources.join('\n').includes('RETRY_STEP_TEXT_SENTINEL');
    assert.equal(inTail || inCoveredSpan, true);
  });

  test('a same-turn load_tools activation survives the retry (review P1-B)', async () => {
    // Review round-2 P1-B repro: active tools were re-derived per streamText
    // call from seed groups + that call's own steps. The retry's steps start
    // empty, so a group loaded before the overflow was silently revoked — the
    // gated tool disappeared from the provider request and the execute
    // boundary rejected it. Activation must accumulate monotonically in the
    // availability owner for the whole send.
    const fixture = buildReactiveFixture({
      script: ['load', 'overflow', 'gated', 'done'],
      bigPriors: true,
      gatedToolGroup: true,
    });
    await runTurn(fixture);

    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    // The retry request still advertises the gated tool...
    const retryRequestTools = JSON.stringify(fixture.model.doStreamCalls[2]?.tools ?? []);
    assert.equal(retryRequestTools.includes('"Big"') || retryRequestTools.includes("'Big'"), true);
    // ...and it executes for real after the retry.
    assert.equal(fixture.toolExecutions.includes('BIG_EXEC'), true);
  });

  test('an actively pruned tool result stays a placeholder in the retry request (review round-3 P1)', async () => {
    // Review round-3 P1 repro: active tool-result pruning derives eligible
    // tool-call IDs from completed Runtime steps. Recovery rebuilds from the
    // durable ledger — which holds
    // the ORIGINAL raw result, not the provider-only placeholder. The retry
    // request therefore resurrected the archived raw body, breaking the
    // active-prune invariant (an archived result never re-enters provider
    // context) and inviting a second overflow. Third instance of the same
    // disease: request-local steps consumed as send-level state.
    //
    // 'bigread' keeps the step text-free so the durable pair is the POOL'S
    // trailing span: the safe boundary cannot split the pair, retreats before
    // the call, and the fold re-materializes the pair verbatim in the tail —
    // from the ledger, which holds the raw body, not the placeholder.
    const fixture = buildReactiveFixture({
      script: ['bigread', 'overflow', 'done'],
      bigPriors: true,
      activeToolResultPrune: true,
    });
    await runTurn(fixture);

    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    // The rejected request had already pruned the big result to a placeholder.
    const overflowPrompt = JSON.stringify(fixture.model.doStreamCalls[1]?.prompt);
    assert.equal(overflowPrompt.includes('BIG_RESULT_'), false);
    assert.equal(overflowPrompt.includes('artifact-archived-1'), true);
    // The retry request must keep the placeholder — never the raw body.
    const retryPrompt = JSON.stringify(fixture.model.doStreamCalls[2]?.prompt);
    assert.equal(retryPrompt.includes('BIG_RESULT_'), false);
    assert.equal(retryPrompt.includes('artifact-archived-1'), true);
  });

  test('a second overflow after the single retry ends as a real error', async () => {
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow', 'overflow'],
      bigPriors: true,
    });
    await runTurn(fixture);

    // The latch permits exactly one compact-and-retry; the retry's overflow is
    // terminal, not a third attempt.
    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      true,
    );
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.llmCalls.at(-1)?.errorClass, 'ContextLength');
  });

  test('no recovery seam means a context-length overflow ends as a real error', async () => {
    const fixture = buildReactiveFixture({
      script: ['tool', 'overflow'],
      midTurnEnabled: false,
      bigPriors: true,
    });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.summarizerCalls(), 0);
  });

  test('an overflow with no foldable completed span ends as a real error', async () => {
    // First-request overflow with no prior turns: the pool is just the current
    // user message, so there is no safe completed span to fold. Recovery is not
    // possible, so the provider error is surfaced honestly (not a fake success,
    // and not a synthesized context_budget_exhausted — the provider rejected).
    const fixture = buildReactiveFixture({ script: ['overflow'], withoutPriorTurns: true });
    await runTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 1);
    assert.equal(complete(fixture)?.stopReason, 'error');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      true,
    );
    assert.equal(fixture.recorded.length, 0);
  });

  test('a steering message survives a transport retry exactly once per request', async () => {
    // The retry base is `attemptRequestMessages`; if it stored the request
    // WITH steering, retry projection would append the accumulator again and
    // double the directive. Invariant: each steering
    // message appears at most once per provider request, 1:1 with its ledger
    // event.
    const fixture = buildReactiveFixture({ script: ['terminated', 'done'] });
    let pulled = false;
    await runTurn(fixture, 'immediate', () => {
      if (pulled) return [];
      pulled = true;
      return [{ id: 'lease-1', messageId: 'message-1', content: { text: STEER_SENTINEL } }];
    });

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    for (const call of fixture.model.doStreamCalls) {
      const prompt = JSON.stringify(call.prompt);
      assert.equal(countOccurrences(prompt, STEER_SENTINEL), 1);
      assert.equal(countOccurrences(prompt, STEERING_ENVELOPE_PREFIX), 1);
    }
    // Exactly one ledger echo for the one steer.
    assert.equal(fixture.events.filter((event) => event.type === 'steering_message').length, 1);
  });

  test('a transport retry keeps a historical ledger-replayed steering message in the base', async () => {
    // Round-4 V2: the steering-free retry base may strip ONLY this turn's
    // injected set — that is exactly what retry projection re-appends. A
    // historical steering message replayed from the ledger
    // carries the same structured marker but a prior turn's event id; nothing
    // re-appends it, so stripping it erased it from every post-retry request.
    const fixture = buildReactiveFixture({ script: ['terminated', 'done'] });
    const historical = runtimeTextEvent('prior-steer', 'turn-0', 'user', HISTORICAL_STEER_SENTINEL);
    (historical.content as { steering?: true }).steering = true;
    fixture.priorEvents.push(historical);
    let pulled = false;
    await runTurn(fixture, 'immediate', () => {
      if (pulled) return [];
      pulled = true;
      return [{ id: 'lease-1', messageId: 'message-1', content: { text: STEER_SENTINEL } }];
    });

    assert.equal(fixture.model.doStreamCalls.length, 2);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    // Both the failed attempt and the retry carry the historical steering
    // exactly once AND this turn's steering exactly once.
    for (const call of fixture.model.doStreamCalls) {
      const prompt = JSON.stringify(call.prompt);
      assert.equal(countOccurrences(prompt, HISTORICAL_STEER_SENTINEL), 1);
      assert.equal(countOccurrences(prompt, STEER_SENTINEL), 1);
      assert.equal(countOccurrences(prompt, STEERING_ENVELOPE_PREFIX), 2);
    }
    assert.equal(fixture.events.filter((event) => event.type === 'steering_message').length, 1);
  });

  test('a persisted steering message appears exactly once in an overflow-rebuilt request', async () => {
    // Reactive recovery rebuilds the projection from the durable ledger, which
    // already carries the steering event — replayed in its canonical envelope
    // form; re-appending the accumulator on top would double it. Whether the
    // fold keeps the event verbatim in the tail or folds it into the summary
    // (envelope re-injected), the directive appears exactly once per request.
    const fixture = buildReactiveFixture({ script: ['tool', 'overflow', 'done'], bigPriors: true });
    let pulled = false;
    await runTurn(fixture, 'immediate', () => {
      if (pulled) return [];
      pulled = true;
      return [{ id: 'lease-1', messageId: 'message-1', content: { text: STEER_SENTINEL } }];
    });

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(complete(fixture)?.stopReason, 'end_turn');
    assert.equal(fixture.recorded.length, 1);
    for (const call of fixture.model.doStreamCalls) {
      const prompt = JSON.stringify(call.prompt);
      assert.equal(countOccurrences(prompt, STEER_SENTINEL), 1);
      assert.equal(countOccurrences(prompt, STEERING_ENVELOPE_PREFIX), 1);
    }
    assert.equal(fixture.events.filter((event) => event.type === 'steering_message').length, 1);
  });

  test('a checkpoint fold never sneaks an injected steering message past the capacity verdict', async () => {
    // Round-5 F2: injected steering is PINNED out of the foldable span. If a
    // mid-turn fold could cover it, the verdict would credit the fold with
    // chars the request never actually sheds (the accumulator re-appends the
    // directive), passing a request whose real payload it never measured.
    //
    // Scenario: steer once at step 1 (6k chars — folds fine, stays in the
    // tail, measured). At step 2 a second, window-breaking steer (12k chars)
    // arrives and the fold's cut can now reach PAST the first steering
    // event. Unpinned, the fold covers it, the verdict sees a shrunken
    // payload and passes, and the post-verdict re-append ships an unmeasured
    // over-window request to a happy end_turn. Pinned, the fold cannot cover
    // it, the honest estimate exceeds the window, and the verdict terminates
    // explicitly BEFORE the request goes out.
    const fixture = buildReactiveFixture({
      script: ['tool', 'tool', 'done'],
      contextWindow: 2_000,
      bigPriors: true,
    });
    let pullCount = 0;
    await runTurn(fixture, 'immediate', () => {
      pullCount += 1;
      if (pullCount === 2)
        return [
          {
            id: 'lease-pin-1',
            messageId: 'message-pin-1',
            content: { text: `PIN_STEER_ONE ${'A'.repeat(6_000)}` },
          },
        ];
      if (pullCount === 3)
        return [
          {
            id: 'lease-pin-2',
            messageId: 'message-pin-2',
            content: { text: `PIN_STEER_TWO ${'B'.repeat(12_000)}` },
          },
        ];
      return [];
    });

    // The verdict measured the pinned, steering-inclusive payload and refused
    // it explicitly instead of completing on an unmeasured over-window request
    // (unpinned, the fold hides the first steer from the measurement and the
    // turn ends happily on end_turn). The third request is rejected locally
    // before the provider adapter is called.
    assert.equal(complete(fixture)?.stopReason, 'context_budget_exhausted');
    assert.equal(fixture.model.doStreamCalls.length, 2);
    // Both steers were durably delivered to the ledger before the verdict —
    // they are owned by history, not lost.
    assert.equal(fixture.events.filter((event) => event.type === 'steering_message').length, 2);
  });

  test('the capacity verdict measures the steering payload the provider will actually receive', async () => {
    // The base request (priors + one tool step) fits the window; the injected
    // steering alone pushes the REAL request over it. Steering joins the
    // request BEFORE shaping, so the single final-request verdict measures
    // the payload the provider will receive and rescues it (one capacity
    // fold) instead of silently sending an over-window request. The old
    // order — append after the verdict — made the verdict blind to steering:
    // no fold, no exhaustion, an unmeasured over-window request.
    const bulkSteer = `CAPACITY_STEER_SENTINEL ${'S'.repeat(20_000)}`;
    const fixture = buildReactiveFixture({
      script: ['tool', 'done'],
      contextWindow: 5_000,
      bigPriors: true,
    });
    let pullCount = 0;
    await runTurn(fixture, 'immediate', () => {
      pullCount += 1;
      // Steer at the SECOND step boundary, after the tool step: the verdict
      // owner (step >= 1) must see the grown payload, not the step-0 baseline.
      return pullCount === 2
        ? [{ id: 'lease-bulk', messageId: 'message-bulk', content: { text: bulkSteer } }]
        : [];
    });

    const outcome = complete(fixture);
    if (outcome?.stopReason === 'end_turn') {
      // Rescued: the capacity owner reacted to the steering-inclusive payload
      // with a mid-turn fold, and the delivered request still carries the
      // steering exactly once.
      assert.equal(fixture.recorded.length >= 1 || fixture.summarizerCalls() >= 1, true);
      const finalPrompt = JSON.stringify(fixture.model.doStreamCalls.at(-1)?.prompt);
      assert.equal(countOccurrences(finalPrompt, 'CAPACITY_STEER_SENTINEL'), 1);
    } else {
      // Not rescuable: the verdict terminates explicitly instead of sending
      // an unmeasured over-window request.
      assert.equal(outcome?.stopReason, 'error');
    }
    assert.equal(fixture.events.filter((event) => event.type === 'steering_message').length, 1);
  });
});

const STEER_SENTINEL = 'STEER_ONCE_SENTINEL directive';
const HISTORICAL_STEER_SENTINEL = 'HISTORICAL_STEER_SENTINEL directive';
const STEERING_ENVELOPE_PREFIX = 'The user sent a message while you were working:';

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let index = haystack.indexOf(needle);
    index !== -1;
    index = haystack.indexOf(needle, index + needle.length)
  ) {
    count += 1;
  }
  return count;
}

function runtimeTextEvent(
  id: string,
  turnId: string,
  role: 'user' | 'model',
  text: string,
): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: 'run-1',
    turnId,
    invocationId: 'run-1',
    ts: 1_800_000_000_000,
    partial: false,
    role,
    author: role === 'user' ? 'user' : 'agent',
    content: { kind: 'text', text },
  };
}

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
    llmConnectionSlug: 'anthropic-main',
    connectionLocked: true,
    model: 'mock-model-id',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'mock-model-id',
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
