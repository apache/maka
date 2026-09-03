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

import type { AgentRunHeader, ModelCallCommit } from '@maka/core/agent-run';
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
import { AiSdkBackend } from '../ai-sdk-backend.js';
import { buildDefaultContextBudgetPolicy } from '../context-budget-policy.js';
import {
  createSessionEventMapMemory,
  mapSessionEventToRuntimeEvent,
} from '../session-event-runtime-mapper.js';
import type { RuntimeEventMapContext } from '../session-event-runtime-mapper.js';
import { applyRuntimeEventContextBudget } from '../context-budget.js';
import type {
  HistoryCompactCheckpoint,
  HistoryCompactProviderState,
} from '../history-compact-checkpoint.js';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import { HistoryCompactSummarizerError } from '../history-compact-error.js';
import { buildLlmHistorySummarizer } from '../history-compact-summarizer.js';
import type { HistoryCompactSummaryInput } from '../ai-sdk-compaction-contract.js';
import { decodeModelCallAttempt, type ModelCallAttempt } from '@maka/core/model-call-attempt';
import type { MemoryExtractionSourceSnapshot } from '../memory-extraction.js';
import {
  LATEST_CONTEXT_PROJECTION_TYPE,
  readLatestContextSnapshot,
} from '../latest-context-snapshot.js';
import {
  createTestAiSdkBackend,
  testToolResultArchive,
} from './execution-boundary-test-helpers.js';

const RAW_SPAN_ONE = 'RAW_SPAN_ONE_'.repeat(24);
const RAW_SPAN_TWO = 'RAW_SPAN_TWO_'.repeat(160);
/** Third-step result big enough that even the rolled-forward fold cannot fit. */
const ROLLING_TAIL = 'ROLLING_TAIL_'.repeat(740);
const HUGE_RESULT = 'HUGE_RESULT_'.repeat(670);
const ANCHOR_TEXT = 'compact this very long turn but keep my exact words';
const BIG_ACTIVE_TOOL_SCHEMA_CHARS = 12_000;

interface MidTurnFixture {
  backend: AiSdkBackend;
  model: MockLanguageModelV4;
  recorded: HistoryCompactCheckpoint[];
  recordedBeforeThirdRequest: () => boolean;
  toolExecutions: string[];
  summarizerCalls: number;
  priorEvents: RuntimeEvent[];
  priorRunHeaders: AgentRunHeader[];
  anchor: RuntimeEvent;
  /** The fixture's durable RuntimeEvent ledger for the current turn/run. */
  ledger: RuntimeEvent[];
  /** Canonical accounting records settled during the turn (#1679). */
  modelCalls: ModelCallAttempt[];
  /**
   * The same settlements as whole commits, so a test can read the derived
   * latest-context row the attempt authorised rather than only the attempt.
   */
  commits: ModelCallCommit<ModelCallAttempt>[];
  ledgerReads: number;
  events: SessionEvent[];
  messages: unknown[];
  llmCalls: Array<{
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    status?: string;
    errorClass?: string;
    contextBudget?: ContextBudgetDiagnostic;
  }>;
  /** JSON of each summarizer call's folded runtime events (coverage evidence). */
  summarizedSources: string[];
  memorySnapshots: MemoryExtractionSourceSnapshot[];
  persist: (event: SessionEvent) => void;
}

interface MidTurnFixtureOptions {
  contextWindow?: number;
  /** Omit the model's context window entirely (unknown model metadata). */
  withoutContextWindow?: boolean;
  /** Keep the model-reported window as metadata without making it a Maka target. */
  declareContextWindow?: boolean;
  /** The model's declared output limit, a provider fact the trigger reserves for the reply. */
  modelMaxOutputTokens?: number;
  /**
   * Derive the policy from the runtime default (buildDefaultContextBudgetPolicy)
   * instead of the hand-built one, so a test can exercise the shipped default.
   */
  useRuntimeDefaultPolicy?: boolean;
  summarize?: (
    input: HistoryCompactSummaryInput,
  ) =>
    | Promise<string | HistoryCompactProviderState | undefined>
    | string
    | HistoryCompactProviderState
    | undefined;
  /** Return and replay a Codex subscription V2 provider checkpoint. */
  providerNative?: boolean;
  branch?: string;
  /** Omit the prior turns so the compaction pool has no safe completed span. */
  withoutPriorTurns?: boolean;
  /** Enable the default-on active tool-result prune with a tiny threshold. */
  activeToolResultPrune?: boolean;
  /**
   * Summarize through the real `buildLlmHistorySummarizer` against a mock
   * provider, so the compaction settles a canonical record instead of the
   * stubbed string the other cases return.
   */
  meteredSummarizer?: boolean;
  /** Override the checkpoint recorder (e.g. to simulate a write failure). */
  record?: (checkpoint: HistoryCompactCheckpoint) => void;
  /** Payload size for each text prior, or for the tool result in a tool-heavy prior. */
  priorChars?: number;
  /** Hydrated image byte length when it must be sized independently from text priors. */
  imageBytes?: number;
  priorShape?: 'text' | 'tool_heavy' | 'image_tool';
  /** Put one image attachment on the durable current-turn user anchor. */
  currentImage?: boolean;
  /** First tool result is huge (finding C: prune must be able to rescue it). */
  hugeFirstResult?: boolean;
  /** Exact first Read result for capacity-ordering regressions. */
  firstResult?: string;
  /** The model finishes on the second request instead of running three steps. */
  finalAtSecondCall?: boolean;
  /** Add a third tool step whose result outgrows even a rolled-forward fold (finding A). */
  rollingOverflow?: boolean;
  /** Tool-search availability with a huge deferred schema (finding D). */
  bigToolGroup?: boolean;
  /** The first step emits assistant text before its tool call (finding B). */
  assistantTextInFirstStep?: boolean;
  /** Override the first step's reported usage; 'missing' = empty usage object. */
  firstStepUsage?: { input: number; output: number } | 'missing';
  /** Make the first provider step end at its output limit. */
  firstStepFinishReason?: 'length';
  /** Override the final (text) step's reported usage. */
  finalStepUsage?: { input: number; output: number };
  /** Prior-turn RuntimeEvents appended after the shaped priors (e.g. a persisted usage anchor). */
  extraPriorEvents?: readonly RuntimeEvent[];
  /** Run headers for the prior turns, so a persisted anchor can be identity-gated. */
  priorRunHeaders?: readonly AgentRunHeader[];
  /** System prompt size sent through the provider's separate system field. */
  systemPromptChars?: number;
  /** An always-active tool whose schema dominates the request payload. */
  bigActiveTool?: boolean;
  /**
   * Run as a child agent with a two-step budget, so the turn's LAST request is
   * the child-summary finalization step: it adds a prompt fragment and sends no
   * tool schemas at all.
   */
  childFinalization?: boolean;
  /** Enable and capture automatic Memory extraction without allowing it to settle. */
  captureMemoryExtraction?: boolean;
  memoryGate?:
    | { readonly allowed: true }
    | {
        readonly allowed: false;
        readonly reason: 'disabled' | 'incognito' | 'unavailable';
      };
}

/**
 * Consumer scheduling mode for a fixture turn. `slow` reproduces the review's
 * scheduling perturbation: the event consumer (which persists to the durable
 * ledger) yields several macrotasks before persisting each event, so the
 * ledger genuinely lags the SDK's step progression and the trigger's seq-ack
 * durability boundary is exercised for real.
 */
type ConsumerMode = 'immediate' | 'slow';

function buildFixture(options: MidTurnFixtureOptions = {}): MidTurnFixture {
  // Most cases model a user-declared target. Keep it between the first and
  // second mock request baselines so the normal three-step journey folds once.
  // Steps report 100/20, then 150/30, then 120/10, so the baselines are 120,
  // 180 and 130 and the reserve (twice the last reply) is 40, 60 and 20. A
  // default window of 190 keeps the first request inside it and crosses on the
  // second, which is the journey these fixtures describe.
  const contextWindow = options.contextWindow ?? 190;
  const recorded: HistoryCompactCheckpoint[] = [];
  const toolExecutions: string[] = [];
  const events: SessionEvent[] = [];
  const messages: unknown[] = [];
  const llmCalls: Array<{
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    status?: string;
    errorClass?: string;
    contextBudget?: ContextBudgetDiagnostic;
  }> = [];
  const summarizedSources: string[] = [];
  const memorySnapshots: MemoryExtractionSourceSnapshot[] = [];
  let recordedAtThirdRequest = false;
  const fixture = { summarizerCalls: 0, ledgerReads: 0 };
  const usage = (input: number, output: number) => ({
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  });
  const firstStepUsage = (): ReturnType<typeof usage> => {
    // A usage object the SDK accepts but whose token counts are absent. The
    // adapter fails closed (undefined), so the capacity hook has no baseline.
    if (options.firstStepUsage === 'missing')
      return { inputTokens: {}, outputTokens: {} } as ReturnType<typeof usage>;
    if (options.firstStepUsage)
      return usage(options.firstStepUsage.input, options.firstStepUsage.output);
    return usage(100, 20);
  };
  const toolCallChunks = (id: string, name: string, args: object): LanguageModelV4StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: id,
      toolName: name,
      input: JSON.stringify(args),
    },
    {
      type: 'finish',
      finishReason:
        id === 'tool-1' && options.firstStepFinishReason === 'length'
          ? { unified: 'length', raw: 'length' }
          : { unified: 'tool-calls', raw: 'tool_calls' },
      usage: id === 'tool-1' ? firstStepUsage() : usage(150, 30),
    },
  ];
  const doneChunks = (): LanguageModelV4StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'done' },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: options.finalStepUsage
        ? usage(options.finalStepUsage.input, options.finalStepUsage.output)
        : usage(120, 10),
    },
  ];
  const chunksForCall = (call: number): LanguageModelV4StreamPart[] => {
    if (options.bigToolGroup) {
      return call === 1 ? toolCallChunks('tool-1', 'tool_search', { query: 'Big' }) : doneChunks();
    }
    if (call === 1) {
      const first = toolCallChunks('tool-1', 'Read', { path: 'one.md' });
      if (!options.assistantTextInFirstStep) return first;
      return [
        first[0]!,
        { type: 'text-start', id: 'step1-text' },
        {
          type: 'text-delta',
          id: 'step1-text',
          delta: 'ASSISTANT_SENTINEL step one reasoning',
        },
        { type: 'text-end', id: 'step1-text' },
        ...first.slice(1),
      ];
    }
    if (options.finalAtSecondCall) return doneChunks();
    if (call === 2) return toolCallChunks('tool-2', 'Read', { path: 'two.md' });
    if (options.rollingOverflow && call === 3)
      return toolCallChunks('tool-3', 'Read', { path: 'three.md' });
    return doneChunks();
  };
  const model = new MockLanguageModelV4({
    doStream: async (streamOptions: { abortSignal?: AbortSignal }) => {
      // A real transport rejects immediately on an already-aborted signal; the
      // mock must mirror that so an exhausted turn never streams the
      // over-budget request.
      if (streamOptions.abortSignal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      const call = model.doStreamCalls.length;
      if (call === 3) recordedAtThirdRequest = recorded.length > 0;
      const chunks = chunksForCall(call);
      return {
        stream: simulateReadableStream({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
  const priorChars = options.priorChars ?? 120;
  const imageBytes = options.imageBytes ?? priorChars;
  const priorEvents: RuntimeEvent[] = options.withoutPriorTurns
    ? []
    : options.priorShape === 'image_tool'
      ? [
          runtimeTextEvent('prior-user', 'turn-0', 'user', 'PRIOR_IMAGE inspect the screenshot'),
          {
            ...runtimeTextEvent('prior-call', 'turn-0', 'model', ''),
            content: {
              kind: 'function_call' as const,
              id: 'prior-image-tool-1',
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
              id: 'prior-image-tool-1',
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
          runtimeTextEvent('prior-model', 'turn-0', 'model', 'PRIOR_IMAGE inspection complete'),
        ]
      : options.priorShape === 'tool_heavy'
        ? [
            runtimeTextEvent('prior-user', 'turn-0', 'user', 'PRIOR_FACT inspect the artifact'),
            {
              ...runtimeTextEvent('prior-call', 'turn-0', 'model', ''),
              content: {
                kind: 'function_call' as const,
                id: 'prior-tool-1',
                name: 'Read',
                args: { path: 'artifact.log' },
              },
            },
            {
              ...runtimeTextEvent('prior-result', 'turn-0', 'model', ''),
              role: 'tool' as const,
              author: 'tool' as const,
              content: {
                kind: 'function_response' as const,
                id: 'prior-tool-1',
                name: 'Read',
                result: `OVERSIZED_TOOL_RESULT_${'r'.repeat(priorChars)}`,
                isError: false,
              },
            },
            runtimeTextEvent('prior-model', 'turn-0', 'model', 'PRIOR_FACT inspection complete'),
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
  priorEvents.push(...(options.extraPriorEvents ?? []));
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
                bytes: imageBytes,
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
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
  };

  // The fixture's durable run ledger: the consumer persists every non-partial
  // mapped RuntimeEvent exactly the way AgentRun.acceptMappedEvent does (same
  // mapper, same RuntimeEventMapContext incl. branch), and the durable-read seam
  // serves it back after pending consumer work has flushed.
  const ledger: RuntimeEvent[] = [anchor];
  const ledgerCtx: RuntimeEventMapContext = {
    sessionId: 'session-1',
    invocationId: 'run-1',
    runId: 'run-1',
    turnId: 'turn-1',
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    now: monotonicClock(),
  };
  const ledgerMemory = createSessionEventMapMemory();
  const persist = (event: SessionEvent): void => {
    const mapped = mapSessionEventToRuntimeEvent(event, ledgerCtx, ledgerMemory);
    // Partial snapshots live in side files and non-terminal errors are never
    // persisted; the immutable ledger holds everything else.
    if (mapped.partial === true) return;
    if (mapped.content?.kind === 'error') return;
    ledger.push(mapped);
  };

  const modelCalls: ModelCallAttempt[] = [];
  const commits: ModelCallCommit<ModelCallAttempt>[] = [];
  const summarizerModel = new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          type: 'text',
          // Structured so it passes the summarizer's checkpoint validation
          // (#3029) while keeping the sentinel greppable in prompts.
          text: '## Goal\nMID_TURN_SUMMARY_SENTINEL\n\n## Progress\n- done\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)',
        },
      ],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 31, noCache: 31, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 7, text: 7, reasoning: 0 },
        raw: { input_tokens: 31, output_tokens: 7 },
      },
      warnings: [],
    },
  });
  const meteredSummarize = buildLlmHistorySummarizer({
    resolveModel: () => summarizerModel,
  });

  const backend = createTestAiSdkBackend({
    sessionId: 'session-1',
    header: options.childFinalization
      ? { ...header(), collaborationMode: 'agent' as const }
      : header(),
    ...(options.childFinalization ? { maxSteps: 2 } : {}),
    appendMessage: async (message) => {
      messages.push(message);
    },
    connection: {
      ...connection(),
      ...(options.providerNative
        ? { slug: 'codex-subscription', providerType: 'openai-codex' as const }
        : {}),
      models: [
        {
          id: 'mock-model-id',
          ...(options.withoutContextWindow ? {} : { contextWindow }),
          ...(options.modelMaxOutputTokens !== undefined
            ? { maxOutputTokens: options.modelMaxOutputTokens }
            : {}),
        },
      ],
      ...(options.withoutContextWindow || options.declareContextWindow === false
        ? {}
        : { relayModelProfiles: { 'mock-model-id': { contextWindow } } }),
    },
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    ...(options.priorShape === 'image_tool' || options.currentImage
      ? {
          supportsVision: true,
          readAttachmentBytes: async () => ({
            ok: true as const,
            bytes: new Uint8Array(imageBytes),
          }),
        }
      : {}),
    tools: [
      {
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        impl: async (args: { path: string }) => {
          toolExecutions.push(args.path);
          if (args.path === 'one.md')
            return {
              body: options.firstResult ?? (options.hugeFirstResult ? HUGE_RESULT : RAW_SPAN_ONE),
            };
          if (args.path === 'three.md') return { body: ROLLING_TAIL };
          return { body: RAW_SPAN_TWO };
        },
      },
      ...(options.bigActiveTool
        ? [
            {
              name: 'BigActive',
              description: `BIG_ACTIVE_SCHEMA ${'A'.repeat(BIG_ACTIVE_TOOL_SCHEMA_CHARS)}`,
              parameters: z.object({ q: z.string() }),
              impl: async () => ({ ok: true }),
            },
          ]
        : []),
      ...(options.bigToolGroup
        ? [
            {
              name: 'Big',
              // A same-turn tool_search activation adds this schema to every later
              // request; the trigger must count it (finding D).
              description: `BIG_SCHEMA ${'D'.repeat(12_000)}`,
              parameters: z.object({ q: z.string() }),
              impl: async () => ({ ok: true }),
            },
          ]
        : []),
    ],
    ...(options.bigToolGroup
      ? { toolAvailability: { groups: [{ id: 'big', toolNames: ['Big'] }] } }
      : {}),
    ...(options.systemPromptChars ? { systemPrompt: 'S'.repeat(options.systemPromptChars) } : {}),
    contextBudget: options.useRuntimeDefaultPolicy
      ? buildDefaultContextBudgetPolicy({
          name: 'runtime-default-mid-turn',
          modelId: 'mock-model-id',
        })
      : {
          name: 'mid-turn-test',
          historyCompact: {
            enabled: true,
            midTurn: { enabled: true },
          },
          ...(options.activeToolResultPrune
            ? {
                activeToolResultPrune: {
                  enabled: true,
                  maxCurrentResultEstimatedTokens: 30,
                },
              }
            : {}),
        },
    ...(options.activeToolResultPrune
      ? {
          toolResultArchive: testToolResultArchive({
            archiveToolResult: () => ({ artifactId: 'artifact-archived-1' }),
          }),
        }
      : {}),
    summarizeHistoryCompact: async (input) => {
      fixture.summarizerCalls += 1;
      summarizedSources.push(JSON.stringify(input.source.foldedRuntimeEvents));
      // The real summarizer is what carries the accounting the backend hands
      // it, so the metered case must go through it rather than a stub.
      if (options.meteredSummarizer) return await meteredSummarize(input);
      const summary = options.providerNative
        ? ({
            kind: 'openai_codex_remote_v2',
            connectionId: 'test-connection-id',
            modelId: 'mock-model-id',
            itemId: 'cmp_mid_turn',
            encryptedContent: 'MID_TURN_ENCRYPTED_STATE',
          } satisfies HistoryCompactProviderState)
        : options.summarize
          ? await options.summarize(input)
          : `## Goal\nMID_TURN_SUMMARY_SENTINEL\n\n## Progress\n${
              // Padded proportionally so the write gate's size floor passes
              // for large folds while small folds keep a compact replacement.
              JSON.stringify(input.source.foldedRuntimeEvents).length > 30_000
                ? `- ${'covered '.repeat(150)}`
                : '- done'
            }\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)`;
      return summary;
    },
    ...(options.meteredSummarizer
      ? {
          persistPreparedRequestArtifact: async () => ({
            artifactId: 'artifact-mid-turn-capture',
          }),
          recordModelCallAttempt: (commit: ModelCallCommit<ModelCallAttempt>) => {
            commits.push(commit);
            modelCalls.push(commit.attempt);
          },
        }
      : {}),
    recordHistoryCompactCheckpoint: (checkpoint) => {
      if (options.record) return options.record(checkpoint);
      recorded.push(checkpoint);
    },
    loadTurnRuntimeEvents: async (turnId) => {
      fixture.ledgerReads += 1;
      // Emulate the durable read: let the event consumer's pending microtask
      // work flush (the real seam awaits the run's serialized write queue).
      await flushMacrotask();
      return ledger.filter((event) => event.turnId === turnId);
    },
    allowMidTurnHistoryCompaction: true,
    ...(options.captureMemoryExtraction
      ? {
          memoryExtraction: {
            gate: async () => options.memoryGate ?? { allowed: true as const },
            automaticGate: () => options.memoryGate ?? { allowed: true as const },
            remember: async () => ({
              status: 'unavailable' as const,
              requestedItems: [],
            }),
            extract: (snapshot: MemoryExtractionSourceSnapshot) => {
              memorySnapshots.push(snapshot);
              return new Promise<void>(() => {});
            },
          },
        }
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
    newId: idGenerator(),
    now: monotonicClock(),
  });
  return {
    backend,
    model,
    recorded,
    recordedBeforeThirdRequest: () => recordedAtThirdRequest,
    toolExecutions,
    get summarizerCalls() {
      return fixture.summarizerCalls;
    },
    get ledgerReads() {
      return fixture.ledgerReads;
    },
    priorEvents,
    priorRunHeaders: [...(options.priorRunHeaders ?? [])],
    anchor,
    ledger,
    modelCalls,
    commits,
    events,
    messages,
    llmCalls,
    summarizedSources,
    memorySnapshots,
    persist,
  };
}

async function runFixtureTurn(
  fixture: MidTurnFixture,
  consumer: ConsumerMode = 'immediate',
): Promise<void> {
  for await (const event of fixture.backend.send({
    runId: 'run-1',
    turnId: 'turn-1',
    headAnchorRuntimeEvent: fixture.anchor,
    text: ANCHOR_TEXT,
    context: [],
    runtimeContext: [...fixture.priorEvents],
    runtimeContextRunHeaders: [...fixture.priorRunHeaders],
  })) {
    if (consumer === 'slow') {
      // Scheduling perturbation: hold the durable write back across several
      // macrotasks so the ledger lags the SDK between steps.
      await flushMacrotask();
      await flushMacrotask();
      await flushMacrotask();
    }
    // The consumer persists before continuing, exactly like AgentRun.
    fixture.persist(event);
    fixture.events.push(event);
  }
}

function promptJson(fixture: MidTurnFixture, call: number): string {
  return JSON.stringify(
    fixture.model.doStreamCalls[call]?.prompt.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  );
}

function compactionDecisions(
  fixture: MidTurnFixture,
): NonNullable<ContextBudgetDiagnostic['compactionDecisions']> {
  const usageEvent = fixture.events.find((event) => event.type === 'token_usage') as
    | { contextBudget?: ContextBudgetDiagnostic }
    | undefined;
  return usageEvent?.contextBudget?.compactionDecisions ?? [];
}

function defineMidTurnSuite(consumer: ConsumerMode): void {
  test('keeps user_stop when stopping while a usage-triggered fold is summarizing', async () => {
    // The fold now starts from the provider's real usage instead of a local
    // estimate, but a user stop during its summarizer call must still end the
    // turn as user_stop — not as a summarizer failure and not as a completed
    // turn.
    let markSummaryStarted: (() => void) | undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });
    let finishSummary: (() => void) | undefined;
    const fixture = buildFixture({
      summarize: () =>
        new Promise<undefined>((resolve) => {
          finishSummary = () => resolve(undefined);
          markSummaryStarted?.();
        }),
    });
    const turn = runFixtureTurn(fixture, consumer);
    await summaryStarted;
    await fixture.backend.stop('user_stop');
    finishSummary?.();
    await turn;

    // The stop landed while the summarizer was running: nothing was persisted,
    // no further tool ran, and the one request attempted after the stop was
    // rejected by the transport on its already-aborted signal.
    assert.equal(fixture.recorded.length, 0);
    assert.deepEqual(fixture.toolExecutions, ['one.md', 'two.md']);
    assert.equal(
      fixture.events.some((event) => event.type === 'abort'),
      true,
    );
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'user_stop');
  });

  test('compacts after provider usage crosses the declared window, persists first, and continues the same turn', async () => {
    const fixture = buildFixture();
    await runFixtureTurn(fixture, consumer);

    // The turn ran three steps and completed normally.
    assert.equal(fixture.model.doStreamCalls.length, 3);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');

    // Coverage came from the durable ledger read, not a mirrored stream.
    assert.equal(fixture.ledgerReads > 0, true);

    // A mid_turn checkpoint was durably recorded before the third request.
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recordedBeforeThirdRequest(), true);
    const checkpoint = fixture.recorded[0]!;
    assert.equal(checkpoint.phase, 'mid_turn');
    assert.deepEqual(checkpoint.headAnchor, {
      runtimeEventId: 'anchor-1',
      turnId: 'turn-1',
    });
    // Coverage: [prior-user, prior-model, anchor, call-1, result-1] — all of
    // them durable in the ledger before the checkpoint was recorded.
    assert.equal(checkpoint.coverage.eventCount, 5);

    // The next step's prompt is [compact block, verbatim head anchor, preserved active span].
    const thirdPrompt = promptJson(fixture, 2);
    assert.match(thirdPrompt, /maka_history_compact_checkpoint/);
    assert.match(thirdPrompt, /MID_TURN_SUMMARY_SENTINEL/);
    assert.equal(thirdPrompt.includes(ANCHOR_TEXT), true);
    // The replaced raw span (first tool result and prior turns) is gone...
    assert.equal(thirdPrompt.includes('RAW_SPAN_ONE_'), false);
    assert.equal(thirdPrompt.includes('PRIOR_FACT'), false);
    // ...while the reserved tail (second tool call/result pair) stays verbatim.
    assert.equal(thirdPrompt.includes('RAW_SPAN_TWO_'), true);
    assert.match(thirdPrompt, /tool-2/);

    // Completed tool calls are not executed again.
    assert.deepEqual(fixture.toolExecutions, ['one.md', 'two.md']);

    // The compaction decision lands in the usage diagnostics with phase mid_turn.
    const midTurnDecision = compactionDecisions(fixture).find(
      (decision) => decision.phase === 'mid_turn',
    );
    assert.equal(midTurnDecision?.decision, 'replaced');
    assert.equal(midTurnDecision?.reason, 'context_limit');
    assert.deepEqual(midTurnDecision?.boundaryIds, [checkpoint.checkpointId]);
  });

  test('replays a Codex V2 mid-turn checkpoint as native provider state', async () => {
    const fixture = buildFixture({ providerNative: true });
    await runFixtureTurn(fixture, consumer);

    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]?.version, 3);
    const thirdPrompt = promptJson(fixture, 2);
    assert.match(thirdPrompt, /MID_TURN_ENCRYPTED_STATE/);
    assert.match(thirdPrompt, /cmp_mid_turn/);
    assert.doesNotMatch(thirdPrompt, /Provider-native OpenAI Codex compaction checkpoint/);
    assert.doesNotMatch(thirdPrompt, /RAW_SPAN_ONE_|PRIOR_FACT/);
    assert.match(thirdPrompt, /RAW_SPAN_TWO_/);
    assert.match(thirdPrompt, new RegExp(ANCHOR_TEXT));
  });

  test('a mid-turn compaction settles a canonical record for the run it interrupts', async () => {
    // End-to-end over the backend glue, not the summarizer in isolation: the
    // accounting identity is built inside `AiSdkCompaction` from the backend's
    // live `runId`, which only exists while a send is in flight. A stubbed
    // resolver in a unit test cannot show that the real one resolves.
    const fixture = buildFixture({ meteredSummarizer: true });
    await runFixtureTurn(fixture, consumer);

    assert.equal(fixture.summarizerCalls, 1);
    const attempts = fixture.modelCalls.map((attempt) => decodeModelCallAttempt(attempt));
    const compaction = attempts.find((attempt) => attempt.callKind === 'history_compact');
    assert.ok(compaction, 'the compaction call must settle its own canonical record');
    assert.equal(compaction.sessionId, 'session-1');
    assert.equal(compaction.runId, 'run-1', 'attributed to the run the send is executing');
    assert.equal(compaction.turnId, 'turn-1');
    assert.equal(compaction.status, 'completed');
    assert.equal(compaction.usageBasis, 'reported');
    assert.equal(compaction.inputTokens, 31);
    assert.equal(compaction.outputTokens, 7);
    // The send's own steps meter separately: one auxiliary call is not folded
    // into the turn it interrupts.
    assert.equal(
      attempts.filter((attempt) => attempt.callKind === 'history_compact').length,
      1,
      'one summarization is one record',
    );
    assert.equal(
      attempts.some((attempt) => attempt.callKind === 'main'),
      true,
      'and the send it interrupts still records its own',
    );
  });

  test('each request seals the fold its own prompt was built under, not the send’s last one', async () => {
    // The boundary is the one fact in the snapshot that moves DURING a send.
    // Read from session state at settlement it would be the newest fold for
    // every request of the send, including the two dispatched before the fold
    // existed — a request reporting a compaction its prompt never saw. So this
    // asserts the difference between requests of ONE send, which is the only
    // assertion a per-tracker value could not also satisfy (#2323).
    const fixture = buildFixture({ meteredSummarizer: true });
    await runFixtureTurn(fixture, consumer);

    assert.equal(fixture.recorded.length, 1, 'one mid-turn fold in this send');
    const checkpoint = fixture.recorded[0]!;
    const mainCommits = fixture.commits
      .filter((commit) => decodeModelCallAttempt(commit.attempt).callKind === 'main')
      .sort((a, b) => a.attempt.step - b.attempt.step);
    assert.equal(mainCommits.length, 3, 'three physical requests, three sealed rows');

    const boundaryOf = (commit: (typeof mainCommits)[number]) =>
      readLatestContextSnapshot({
        type: LATEST_CONTEXT_PROJECTION_TYPE,
        data: commit.latestContext?.snapshot,
      })?.compaction;

    assert.equal(boundaryOf(mainCommits[0]!), undefined, 'nothing was folded yet');
    assert.equal(boundaryOf(mainCommits[1]!), undefined, 'still nothing at the second request');
    assert.deepEqual(
      boundaryOf(mainCommits[2]!),
      {
        kind: 'history',
        phase: 'mid_turn',
        eventCount: checkpoint.coverage.eventCount,
        turnCount: checkpoint.coverage.turnCount,
        estimatedTokens: checkpoint.estimatedTokens,
      },
      'the request built after the fold reports that fold, in the checkpoint’s own numbers',
    );
  });

  test('recovery re-projection with ctx.branch replays the checkpoint without the raw span', async () => {
    const fixture = buildFixture({ branch: 'lane-7' });
    await runFixtureTurn(fixture, consumer);
    assert.equal(fixture.recorded.length, 1);
    const checkpoint = fixture.recorded[0]!;

    // The durable ledger the coverage was computed over carries the branch on
    // every current-turn event, because the fixture consumer maps with the
    // same RuntimeEventMapContext (including branch) as RuntimeKernel.
    for (const event of fixture.ledger) {
      assert.equal(event.branch, 'lane-7');
    }

    // Recovery: re-project prior turns + the durable current-turn ledger with
    // normal thresholds — the checkpoint replays and the covered raw span is
    // never re-injected, even though the raw history is otherwise small.
    const replay = applyRuntimeEventContextBudget([...fixture.priorEvents, ...fixture.ledger], {
      historyCompact: { enabled: true, checkpoint },
    });

    assert.ok(replay);
    const replayIds = replay.events.map((event) => event.id);
    assert.equal(replayIds[0], `history-compact:${checkpoint.checkpointId}`);
    assert.equal(replayIds.includes('anchor-1'), true);
    assert.deepEqual(replay.events[1], fixture.anchor);
    assert.equal(replayIds.includes('prior-user'), false);
    assert.equal(replayIds.includes('prior-model'), false);
    const replayJson = JSON.stringify(replay.events);
    assert.equal(replayJson.includes('RAW_SPAN_ONE_'), false);
    assert.equal(replayJson.includes('RAW_SPAN_TWO_'), true);
  });

  test('sends an over-window request no shaper could rescue, rather than ending the turn', async () => {
    // No prior turns and a window the first step's usage already exceeds: the
    // pool is [anchor, one open call/result pair], so no safe completed span
    // and nothing to compact. Only the provider can say whether that request
    // fits, so it goes out and the turn runs to its own end.
    const fixture = buildFixture({
      contextWindow: 120,
      withoutPriorTurns: true,
    });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(
      fixture.events.some(
        (event) =>
          event.type === 'tool_start' &&
          event.toolName === 'Read' &&
          JSON.stringify(event.args).includes('two.md'),
      ),
      true,
    );
  });

  test('a summary that cannot fit its own input fails open and still dispatches', async () => {
    const fixture = buildFixture({
      contextWindow: 100,
      useRuntimeDefaultPolicy: true,
      summarize: () => {
        throw new HistoryCompactSummarizerError('input_too_large');
      },
    });

    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    assert.equal(fixture.summarizerCalls > 0, true);
  });

  test('fails open with write_failed diagnostics when the checkpoint write fails', async () => {
    const fixture = buildFixture({
      record: () => {
        throw new Error('disk full');
      },
    });
    await runFixtureTurn(fixture, consumer);

    // The turn still completes on the raw projection; nothing durable claims
    // a successful write.
    assert.equal(fixture.model.doStreamCalls.length, 3);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    assert.equal(fixture.recorded.length, 0);
    assert.equal(promptJson(fixture, 2).includes('RAW_SPAN_ONE_'), true);

    const failedOpen = compactionDecisions(fixture).find(
      (decision) => decision.phase === 'mid_turn' && decision.decision === 'failedOpen',
    );
    assert.equal(failedOpen?.failOpenReason, 'write_failed');
  });

  test('a malformed summarizer completion fails open end-to-end with its granular reason', async () => {
    // #3029 acceptance criterion, end-to-end through the REAL summarizer:
    // reject → checkpoint not written → history preserved → the granular
    // reason lands in the durable compaction diagnostics.
    const malformedSummarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({
        // The incident's shape: free-form prose, no mandated sections.
        text: '确认服务端语义后，先只在文本路径上加入预算判断。',
        finishReason: 'stop',
      }),
    });
    const fixture = buildFixture({
      summarize: (input) => malformedSummarize(input),
    });
    await runFixtureTurn(fixture, consumer);

    // The turn still completes on the raw projection; nothing durable claims
    // a checkpoint, and the raw span the fold would have replaced is still in
    // the next prompt.
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    assert.equal(fixture.recorded.length, 0);
    assert.equal(promptJson(fixture, 2).includes('RAW_SPAN_ONE_'), true);

    const failedOpen = compactionDecisions(fixture).find(
      (decision) => decision.phase === 'mid_turn' && decision.decision === 'failedOpen',
    );
    assert.equal(failedOpen?.failOpenReason, 'malformed_summary_missing_section');
  });

  test('bounds malformed-summary attempts across later steps in the same turn', async () => {
    const fixture = buildFixture({
      rollingOverflow: true,
      summarize: () => {
        throw new HistoryCompactSummarizerError('malformed_summary_missing_section');
      },
    });

    await runFixtureTurn(fixture, consumer);

    // One repair budget for the whole turn: a later step never re-runs it.
    assert.equal(fixture.summarizerCalls, 1);
    assert.equal(fixture.recorded.length, 0);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
  });

  test('bounds a provider-error summarizer failure across later steps in the same turn', async () => {
    // The baseline that fired this trigger survives a fail-open, so without a
    // latch every later step re-evaluates it and dispatches the same doomed
    // call. Live evidence: 15 consecutive failed summarizer calls over ~47
    // minutes on a provider that answers slowly and fails (#4634).
    const fixture = buildFixture({
      rollingOverflow: true,
      summarize: () => {
        throw new HistoryCompactSummarizerError('provider_error');
      },
    });

    await runFixtureTurn(fixture, consumer);

    assert.equal(fixture.summarizerCalls, 1);
    assert.equal(fixture.recorded.length, 0);
    const failedOpen = compactionDecisions(fixture).filter(
      (decision) => decision.decision === 'failedOpen',
    );
    assert.ok(failedOpen.length >= 1);
    assert.equal(failedOpen[0]?.failOpenReason, 'provider_error');
  });

  test('does not report provider dropping when the step dropped its tool schemas', async () => {
    // A finalization step resolves an empty tool set, so its request loses
    // several thousand schema tokens with no fold, prune or image omission.
    // Maka shaped that request; the provider dropped nothing.
    const fixture = buildFixture({
      contextWindow: 200,
      finalAtSecondCall: true,
      childFinalization: true,
      finalStepUsage: { input: 50, output: 10 },
    });
    await runFixtureTurn(fixture, consumer);

    assert.equal(
      fixture.messages.some(
        (message) =>
          (message as { type?: string; kind?: string }).type === 'system_note' &&
          (message as { kind?: string }).kind === 'context_provider_dropping',
      ),
      false,
    );
  });

  test('fails closed before provider dispatch when the durable ledger read fails', async () => {
    const fixture = buildFixture();
    // Break the seam after construction: every trigger read now rejects.
    (
      fixture.backend as unknown as {
        input: { loadTurnRuntimeEvents: () => Promise<RuntimeEvent[]> };
      }
    ).input.loadTurnRuntimeEvents = () => Promise.reject(new Error('ledger offline'));
    await runFixtureTurn(fixture, consumer);

    // Durable replay is the source of truth for every request, not merely a
    // compaction input. Continuing on a stale in-memory projection would risk
    // repeating tool side effects, so the Runtime fails before dispatch.
    assert.equal(fixture.model.doStreamCalls.length, 0);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'error');
    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.summarizerCalls, 0);
  });

  test('active tool-result prune re-converges the rebuilt tail after a capacity replacement', async () => {
    const fixture = buildFixture({ activeToolResultPrune: true });
    await runFixtureTurn(fixture, consumer);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(fixture.recorded.length, 1);
    const thirdPrompt = promptJson(fixture, 2);
    // Capacity compaction owns the projection: compact block + verbatim anchor.
    assert.match(thirdPrompt, /maka_history_compact_checkpoint/);
    assert.equal(thirdPrompt.includes(ANCHOR_TEXT), true);
    assert.equal(thirdPrompt.includes('RAW_SPAN_ONE_'), false);
    // The large tool result in the rebuilt tail is re-archived to a
    // placeholder by the prune hook running AFTER the capacity hook — the
    // capacity replacement must not resurrect the raw body.
    assert.equal(thirdPrompt.includes('RAW_SPAN_TWO_'), false);
    assert.match(thirdPrompt, /artifact-archived-1/);
    assert.match(thirdPrompt, /active_current_turn_tool_result_pruned_before_next_step/);
  });

  test('compacts at most once per send', async () => {
    // The proactive fold already covers everything except the live head. A
    // second fold in the same send would buy the small verbatim tail and cost
    // the most recent context, so the send spends one call and no more.
    const fixture = buildFixture({ priorChars: 2_000, rollingOverflow: true });
    await runFixtureTurn(fixture, consumer);

    assert.equal(fixture.summarizerCalls, 1);
    assert.equal(fixture.recorded.length, 1);
  });

  test('a prune-rescuable step is rescued by the prune, not compacted (review finding C)', async () => {
    // Review round-3 finding C repro: one huge tool result, no safe completed
    // span for the capacity hook, but the active tool-result prune (which runs
    // AFTER the capacity hook) archives the result down to a placeholder that
    // fits the window.
    const fixture = buildFixture({
      contextWindow: 100,
      withoutPriorTurns: true,
      hugeFirstResult: true,
      finalAtSecondCall: true,
      activeToolResultPrune: true,
    });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    assert.equal(fixture.model.doStreamCalls.length, 2);
    // The second request carries the archive placeholder, not the raw body.
    const secondPrompt = promptJson(fixture, 1);
    assert.equal(secondPrompt.includes('HUGE_RESULT_'), false);
    assert.match(secondPrompt, /artifact-archived-1/);
    // The capacity hook's failure is a diagnostic, not a terminal outcome.
    const failedOpen = compactionDecisions(fixture).find(
      (decision) => decision.phase === 'mid_turn' && decision.decision === 'failedOpen',
    );
    assert.equal(failedOpen?.failOpenReason, 'no_safe_completed_span');
  });

  test('the trigger counts same-turn tool-schema growth from tool_search (review finding D)', async () => {
    // Review round-3 finding D repro: the model activates a ~12.7k-char tool
    // group mid-turn. The schema lands in every later request, so the payload
    // estimate must count it — without that the 500-token window is never
    // crossed and the trigger never fires at all.
    const fixture = buildFixture({
      contextWindow: 100,
      withoutPriorTurns: true,
      bigToolGroup: true,
    });
    await runFixtureTurn(fixture, consumer);

    // The pool has no safe completed span, so the fired trigger fails open.
    const failedOpen = compactionDecisions(fixture).find(
      (decision) => decision.phase === 'mid_turn' && decision.decision === 'failedOpen',
    );
    assert.equal(failedOpen?.failOpenReason, 'no_safe_completed_span');
  });

  test("the usage baseline is the last request's input plus output", async () => {
    // Baseline 120 (100 + 20) with a 40-token reserve (twice the 20-token
    // reply). A window of 155 is crossed only because the baseline counts the
    // output: input alone plus the reserve is 140, which fits.
    const compacting = buildFixture({
      contextWindow: 155,
      finalAtSecondCall: true,
      firstStepUsage: { input: 100, output: 20 },
    });
    await runFixtureTurn(compacting, consumer);

    assert.equal(compacting.summarizerCalls, 1);
    assert.match(promptJson(compacting, 1), /maka_history_compact_checkpoint/);

    const fitting = buildFixture({
      contextWindow: 165,
      finalAtSecondCall: true,
      firstStepUsage: { input: 100, output: 20 },
    });
    await runFixtureTurn(fitting, consumer);

    assert.equal(fitting.summarizerCalls, 0);
  });

  test('reports an accepted request past the window the model reports when nothing is declared', async () => {
    // The kimi k3-256k shape: the provider accepts past its own reported
    // window without rejecting or truncating, so no other signal fires.
    const fixture = buildFixture({
      contextWindow: 100,
      declareContextWindow: false,
      finalAtSecondCall: true,
      firstStepUsage: { input: 150, output: 40 },
    });
    await runFixtureTurn(fixture, consumer);

    const note = fixture.messages.find(
      (message): message is { type: 'system_note'; kind: string; data?: unknown } =>
        (message as { kind?: string }).kind === 'context_reported_window_exceeded',
    );
    assert.deepEqual(note?.data, { usedTokens: 190, reportedContextWindow: 100 });
    // A hint is still not a declaration: nothing folded on its own.
    assert.equal(fixture.summarizerCalls, 0);
  });

  test('does not repeat the reported-window note once the session is already past the line', async () => {
    // On these providers usage keeps growing past the reported window, so the
    // note fires on the crossing, not on every send. A persisted anchor that
    // is already over the line carries that across sessions.
    const fixture = buildFixture({
      contextWindow: 100,
      declareContextWindow: false,
      finalAtSecondCall: true,
      firstStepUsage: { input: 150, output: 40 },
      extraPriorEvents: [priorUsageEvent({ inputTokens: 300, outputTokens: 20 })],
      priorRunHeaders: [priorRunHeader()],
    });
    await runFixtureTurn(fixture, consumer);

    assert.equal(
      fixture.messages.some(
        (message) => (message as { kind?: string }).kind === 'context_reported_window_exceeded',
      ),
      false,
    );
  });

  test('does not report the reported window when the user declared one', async () => {
    // With a declaration the overrun note owns this case; two notes for one
    // fact would be noise.
    const fixture = buildFixture({
      contextWindow: 100,
      finalAtSecondCall: true,
      firstStepUsage: { input: 150, output: 40 },
    });
    await runFixtureTurn(fixture, consumer);

    assert.equal(
      fixture.messages.some(
        (message) => (message as { kind?: string }).kind === 'context_reported_window_exceeded',
      ),
      false,
    );
  });

  test('reports a reply that ran past the declared window', async () => {
    const fixture = buildFixture({
      contextWindow: 200,
      finalAtSecondCall: true,
      firstStepUsage: { input: 150, output: 60 },
    });
    await runFixtureTurn(fixture, consumer);

    const note = fixture.messages.find(
      (message): message is { type: 'system_note'; kind: string; data?: unknown } =>
        (message as { type?: string }).type === 'system_note' &&
        (message as { kind?: string }).kind === 'context_window_overrun',
    );
    assert.deepEqual(note?.data, { usedTokens: 210, declaredContextWindow: 200 });
  });

  test('does not report an overrun for an exchange that stayed inside the window', async () => {
    const fixture = buildFixture({
      contextWindow: 200,
      finalAtSecondCall: true,
      firstStepUsage: { input: 150, output: 40 },
    });
    await runFixtureTurn(fixture, consumer);

    assert.equal(
      fixture.messages.some(
        (message) => (message as { kind?: string }).kind === 'context_window_overrun',
      ),
      false,
    );
  });

  test('records provider context dropping when an append-only step reports the same usage', async () => {
    // The Ollama shape: the provider truncates to its own window, so input
    // stops growing rather than dropping while Maka keeps appending. A
    // plateau is the signal the copy promises ("usage did not grow").
    const fixture = buildFixture({
      contextWindow: 200,
      finalAtSecondCall: true,
      firstStepUsage: { input: 100, output: 20 },
      finalStepUsage: { input: 100, output: 10 },
    });
    await runFixtureTurn(fixture, consumer);

    const note = fixture.messages.find(
      (message): message is { type: 'system_note'; kind: string } =>
        (message as { type?: string }).type === 'system_note',
    );
    assert.equal(note?.kind, 'context_provider_dropping');
  });

  test('records provider context dropping only for an unshaped usage decrease', async () => {
    const fixture = buildFixture({
      contextWindow: 200,
      finalAtSecondCall: true,
      finalStepUsage: { input: 50, output: 10 },
    });
    await runFixtureTurn(fixture, consumer);

    const note = fixture.messages.find(
      (message): message is { type: 'system_note'; kind: string } =>
        (message as { type?: string }).type === 'system_note',
    );
    assert.equal(note?.kind, 'context_provider_dropping');
  });

  test('does not call provider context dropping when active pruning explains the decrease', async () => {
    const fixture = buildFixture({
      contextWindow: 200,
      finalAtSecondCall: true,
      hugeFirstResult: true,
      activeToolResultPrune: true,
      finalStepUsage: { input: 50, output: 10 },
    });
    await runFixtureTurn(fixture, consumer);

    assert.equal(
      fixture.messages.some(
        (message) =>
          (message as { type?: string; kind?: string }).type === 'system_note' &&
          (message as { kind?: string }).kind === 'context_provider_dropping',
      ),
      false,
    );
  });

  test('a provider output-limit finish does not fold', async () => {
    // A reply cut at `length` can mean the provider ran out of window room or
    // that its own output cap is lower than the one Maka sends. Those are
    // indistinguishable from outside, so the signal drives nothing (#4559).
    const fixture = buildFixture({
      withoutContextWindow: true,
      finalAtSecondCall: true,
      firstStepFinishReason: 'length',
    });
    await runFixtureTurn(fixture, consumer);

    assert.equal(fixture.summarizerCalls, 0);
    assert.equal(fixture.recorded.length, 0);
  });

  test("a completed step's assistant text is never dropped from the replacement (review finding B)", async () => {
    // Review round-3 finding B repro: the FIRST step emits assistant text AND
    // a tool call, and the trigger fires at that step's own boundary. The old
    // durable watermark waited only for the tool call/response pair — which
    // are enqueued DURING the step, before the pump flushes the step's
    // text_complete — so under a slow consumer the ledger could satisfy the
    // watermark while the already-emitted assistant text was still missing.
    // Because the replacement projection replaces the WHOLE message list,
    // that text silently vanished from the next request. The seq-ack boundary
    // counts the event stream itself (pump flush of the step boundary + the
    // consumer's processed ack), so the durable pool must contain the step's
    // text before any coverage is computed.
    const fixture = buildFixture({
      // High water at 100 tokens: the first request's 100 input tokens plus
      // its assistant/tool-result delta crosses it at the step-1 boundary.
      contextWindow: 100,
      assistantTextInFirstStep: true,
      finalAtSecondCall: true,
    });
    await runFixtureTurn(fixture, consumer);

    // The text was emitted to the user...
    assert.equal(
      fixture.events.some(
        (event) => event.type === 'text_complete' && event.text.includes('ASSISTANT_SENTINEL'),
      ),
      true,
    );
    // ...and the projection accounts for it: the step-1 text event is in the
    // durable pool before the second request is projected, so it survives
    // either verbatim in the preserved tail or inside a summarized covered
    // span. The current replay groups text and tool calls from one provider
    // step, so the safe planner may correctly retain that indivisible step
    // instead of recording a checkpoint.
    const secondPrompt = promptJson(fixture, 1);
    const inTail = secondPrompt.includes('ASSISTANT_SENTINEL');
    const inCoveredSpan = fixture.summarizedSources.join('\n').includes('ASSISTANT_SENTINEL');
    assert.equal(inTail || inCoveredSpan, true);
    // The turn still completes normally on the compacted projection.
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
  });
}

describe('mid-turn capacity compaction in the streaming backend', () => {
  defineMidTurnSuite('immediate');

  test('dispatches a mid-turn Compaction recipe after persistence without awaiting it', async () => {
    const fixture = buildFixture({
      captureMemoryExtraction: true,
      systemPromptChars: 32,
    });
    await runFixtureTurn(fixture);

    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.memorySnapshots.length, 1);
    const checkpoint = fixture.recorded[0]!;
    const snapshot = fixture.memorySnapshots[0]!;
    assert.equal(snapshot.trigger, 'compaction');
    assert.equal(snapshot.compactionCheckpointId, checkpoint.checkpointId);
    assert.equal(
      snapshot.compactionBoundaryEventId,
      checkpoint.memoryExtractionBoundary?.runtimeEventId,
    );
    assert.ok(
      fixture.ledger.some((event) => event.id === snapshot.compactionBoundaryEventId),
      'the frozen boundary must be durable before dispatch',
    );
    assert.deepEqual(snapshot.sourceMessages, []);
    assert.equal(snapshot.rebuildSourceContextFromCompactionCheckpoint, true);
    assert.equal(snapshot.sourceSystemPrompt, undefined);
    assert.deepEqual(snapshot.sourceTools, {});
    assert.deepEqual(snapshot.sourceActiveTools, []);
    assert.equal(fixture.model.doStreamCalls.length, 3, 'the unresolved extraction must not block');
  });

  test('persists a denied marker without dispatching mid-turn Memory extraction', async () => {
    const fixture = buildFixture({
      captureMemoryExtraction: true,
      memoryGate: { allowed: false, reason: 'disabled' },
    });
    await runFixtureTurn(fixture);

    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]?.memoryExtractionBoundary?.disposition, 'policy_denied');
    assert.equal(fixture.memorySnapshots.length, 0);
    assert.equal(fixture.model.doStreamCalls.length, 3);
  });
});

describe('mid-turn capacity compaction with a slow ledger consumer', () => {
  // Review round-2/3 repro: the consumer that persists to the durable ledger
  // yields several macrotasks per event, so the ledger genuinely lags the
  // SDK's step progression. The seq-ack durability boundary must make every
  // behavior above hold identically — no over-window request slipping out,
  // and no completed-step content silently dropped from a replacement.
  defineMidTurnSuite('slow');
});

describe('mid-turn capacity default-on safety guards (issue #882 PR 3)', () => {
  test('does not omit hydrated images before a selected-model step-zero provider verdict', async () => {
    const fixture = buildFixture({
      contextWindow: 10_000,
      currentImage: true,
      imageBytes: 8_000,
      priorShape: 'image_tool',
    });
    await runFixtureTurn(fixture);

    const firstMessages = fixture.model.doStreamCalls[0]?.prompt ?? [];
    const firstPrompt = promptJson(fixture, 0);
    assert.equal(fixture.model.doStreamCalls.length > 0, true);
    assert.equal(firstPrompt.match(/"mediaType":"image\/png"/g)?.length, 2);
    assert.equal(
      firstMessages.some(
        (message) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === 'file' && part.mediaType === 'image/png'),
      ),
      true,
    );
    assert.equal(
      firstMessages.some(
        (message) =>
          message.role === 'tool' &&
          message.content.some(
            (part) =>
              part.type === 'tool-result' &&
              part.toolCallId === 'prior-image-tool-1' &&
              part.output.type === 'content' &&
              part.output.value.some(
                (outputPart) => outputPart.type === 'file' && outputPart.mediaType === 'image/png',
              ),
          ),
      ),
      true,
    );
    assert.doesNotMatch(firstPrompt, /omitted after provider context overflow/);
    assert.equal(fixture.summarizerCalls, 0);
  });

  test('keeps the fallback capacity guard inert below its unknown-model bound', async () => {
    // The unknown model derives a 48,384-token capacity from the default
    // 32,000-token history budget plus its 16,384-token reserve. This small
    // turn stays below that bound, so no compaction runs.
    const fixture = buildFixture({ withoutContextWindow: true });
    await runFixtureTurn(fixture);

    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.summarizerCalls, 0);
    assert.equal(fixture.ledgerReads > 0, true);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    // The raw span is never folded away, proving no compaction ran.
    assert.equal(promptJson(fixture, 2).includes('RAW_SPAN_ONE_'), true);
  });

  test('measures a materialized image by what it bills, not by its serialized bytes', async () => {
    // apache/maka#4458. The unknown model's 48,384-token fallback capacity is
    // enforced from step 0. A 200 KB screenshot reaches the request as base64,
    // so measuring the serialized payload prices these two images at ~130,000
    // tokens and ends the turn before a single provider call — while the
    // provider itself would charge a few thousand.
    const fixture = buildFixture({
      withoutContextWindow: true,
      currentImage: true,
      imageBytes: 200_000,
      priorShape: 'image_tool',
    });
    await runFixtureTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length > 0, true);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    // Nothing was folded or dropped: at the real cost the request fits.
    assert.equal(fixture.summarizerCalls, 0);
    assert.doesNotMatch(promptJson(fixture, 0), /omitted after provider context overflow/);
  });

  test('keeps multiple bounded recent turns below the model capacity', async () => {
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      contextWindow: 100_000,
      priorChars: 40_000,
    });
    fixture.priorEvents.push(
      runtimeTextEvent('second-user', 'turn-second', 'user', `SECOND_USER_${'u'.repeat(40_000)}`),
      runtimeTextEvent(
        'second-model',
        'turn-second',
        'model',
        `SECOND_MODEL_${'m'.repeat(40_000)}`,
      ),
    );
    await runFixtureTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
  });

  test('lets an undeclared window dispatch a payload no local number can judge', async () => {
    // A 200,000-char system prompt against a model that declares no window.
    // The runtime used to add its 32,000-token history budget to the 16,384
    // reserve, call the sum a context window, and end the turn on it. Both are
    // policy choices about how much history to keep; neither says what this
    // model accepts, so the request goes out and the provider answers.
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      withoutContextWindow: true,
      systemPromptChars: 200_000,
    });
    await runFixtureTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length > 0, true);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
  });

  test('does not fire for a session without a persisted head anchor (child sessions have no seam)', async () => {
    // PR 1's decision: child sessions are structurally without the head-anchor
    // seam, so even with midTurn on by default the trigger must never activate.
    // Sending without a headAnchorRuntimeEvent reproduces that shape.
    const fixture = buildFixture();
    const events: SessionEvent[] = [];
    for await (const event of fixture.backend.send({
      runId: 'run-1',
      turnId: 'turn-1',
      text: ANCHOR_TEXT,
      context: [],
      runtimeContext: [...fixture.priorEvents],
    })) {
      fixture.persist(event);
      events.push(event);
    }

    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.summarizerCalls, 0);
    const complete = events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
  });

  test('treats a /models context window as metadata unless the user declares it', async () => {
    const reported = buildFixture({
      useRuntimeDefaultPolicy: true,
      contextWindow: 100,
      declareContextWindow: false,
    });
    await runFixtureTurn(reported);
    assert.equal(reported.summarizerCalls, 0);

    const declared = buildFixture({
      useRuntimeDefaultPolicy: true,
      contextWindow: 190,
    });
    await runFixtureTurn(declared);
    assert.equal(declared.summarizerCalls, 1);
    assert.match(promptJson(declared, 2), /maka_history_compact_checkpoint/);
  });
});

describe('the shipped runtime default drives the proactive long-turn journey (issue #882 PR 3)', () => {
  test('a long turn near the window compacts mid-turn, persists the checkpoint, and continues instead of truncating', async () => {
    // No hand-built policy and no env override: this wires
    // buildDefaultContextBudgetPolicy — the exact default every surface now
    // inherits — into the backend. A long turn whose real usage crosses
    // Real provider usage crossing the declared window must fold a safe
    // completed prefix into a DURABLE mid_turn
    // checkpoint and continue the SAME turn to normal completion, never
    // truncate it or surface a raw provider error.
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      contextWindow: 190,
      priorChars: 1_400,
    });
    await runFixtureTurn(fixture);

    // The checkpoint was durably persisted (not a fail-open raw continuation).
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]?.phase, 'mid_turn');
    // The continued request rides the compacted projection: the compact block
    // is present and the replaced raw span is gone.
    const continuedPrompt = promptJson(fixture, 2);
    assert.match(continuedPrompt, /maka_history_compact_checkpoint/);
    assert.match(continuedPrompt, /MID_TURN_SUMMARY_SENTINEL/);
    assert.equal(continuedPrompt.includes('PRIOR_FACT'), false);
    assert.equal(continuedPrompt.includes(ANCHOR_TEXT), true);
    // ...and the turn continued through all three steps to a clean end — no
    // truncation, no raw provider error surfaced to the user.
    assert.equal(fixture.model.doStreamCalls.length, 3);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
  });

  test('persists the last request input and output as the anchor', async () => {
    const fixture = buildFixture({
      contextWindow: 1_000_000,
      finalAtSecondCall: true,
    });
    await runFixtureTurn(fixture);

    const usage = fixture.messages.find(
      (
        message,
      ): message is {
        type: 'token_usage';
        input: number;
        lastRequestAnchor?: unknown;
      } => (message as { type?: string }).type === 'token_usage',
    );
    // Two steps: 100 + 120 reported input, and the send sum is both.
    assert.equal(usage?.input, 220);
    const anchor = usage?.lastRequestAnchor as
      | { inputTokens: number; outputTokens?: number }
      | undefined;
    assert.equal(anchor?.inputTokens, 120);
    assert.equal(anchor?.outputTokens, 10);
  });

  test('an anchor is discarded unless a run header proves it came from this model', async () => {
    // Input tokens are a count in one model's tokenizer; nothing converts them.
    // The anchor sits ABOVE the declared window, so it is the header check
    // alone that decides: a matching header folds at step 0, while a header
    // naming another model and no header at all leave the request alone.
    const anchor = priorUsageEvent({ inputTokens: 30_000, outputTokens: 10 });
    for (const [priorRunHeaders, folds] of [
      [[priorRunHeader()], true],
      [[{ ...priorRunHeader(), modelId: 'some-other-model' }], false],
      [[], false],
    ] as const) {
      const fixture = buildFixture({
        priorChars: 2_000,
        contextWindow: 20_000,
        finalAtSecondCall: true,
        extraPriorEvents: [anchor],
        priorRunHeaders: [...priorRunHeaders],
      });
      await runFixtureTurn(fixture);

      assert.equal(fixture.recorded.length, folds ? 1 : 0);
    }
  });

  test('a synthetic /compact usage row does not shadow the real anchor', async () => {
    // A manual /compact writes `input: 0, output: 0` without a provider send,
    // so it carries no anchor: the reverse scan skips it and still finds the
    // last real request, which is above the window and folds step 0.
    const fixture = buildFixture({
      priorChars: 2_000,
      contextWindow: 20_000,
      finalAtSecondCall: true,
      extraPriorEvents: [
        priorUsageEvent({ inputTokens: 30_000, outputTokens: 10 }),
        {
          ...runtimeTextEvent('prior-compact-usage', 'turn-0', 'model', ''),
          id: 'prior-compact-usage',
          runId: 'run-0',
          invocationId: 'run-0',
          role: 'system' as const,
          author: 'system' as const,
          content: undefined,
          actions: { tokenUsage: { input: 0, output: 0 } },
        },
      ],
      priorRunHeaders: [priorRunHeader()],
    });
    await runFixtureTurn(fixture);

    assert.equal(fixture.recorded.length, 1);
    const fold = compactionDecisions(fixture).find(
      (decision) => decision.stage === 'activeStep' && decision.decision === 'replaced',
    );
    assert.equal(fold?.phase, 'pre_turn');
  });

  test('the reserve is twice the last real reply, bounded, not the model output limit', async () => {
    // With the window declared at the provider's real size, an accepted
    // request can never exceed it on its own; the reply the next request must
    // leave room for is what tips it. That room is measured from the reply the
    // model actually wrote, so a session whose answers are long reserves more
    // than one whose answers are short, and neither number is a guess. The
    // model's own output limit is deliberately not the reserve: on k3-256k it
    // is half the window and would fold at 50% utilization (#4634).
    for (const [anchorOutput, folds] of [
      [60, true],
      [5, false],
    ] as const) {
      const fixture = buildFixture({
        priorChars: 200,
        contextWindow: 1_000,
        finalAtSecondCall: true,
        modelMaxOutputTokens: 600,
        extraPriorEvents: [priorUsageEvent({ inputTokens: 900, outputTokens: anchorOutput })],
        priorRunHeaders: [priorRunHeader()],
      });
      await runFixtureTurn(fixture);
      // 960 + 120 crosses 1,000; 905 + 10 does not. The 600-token output limit
      // is irrelevant to both.
      assert.equal(fixture.summarizerCalls, folds ? 1 : 0);
    }
  });

  test('an unrescuable turn under the shipped default still dispatches', async () => {
    // No prior turns leaves no safe completed span. The request still goes out
    // because only the provider can decide whether it fits.
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      contextWindow: 120,
      withoutPriorTurns: true,
    });
    await runFixtureTurn(fixture);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    assert.equal(fixture.model.doStreamCalls.length > 0, true);
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
  });
});

/**
 * The turn's durable token_usage RuntimeEvents, re-labelled as a previous turn
 * so the next fixture turn sees them the way `prior-run-context` serves them
 * back after a restart.
 */
function priorUsageEvent(lastRequestAnchor: {
  inputTokens: number;
  outputTokens?: number;
}): RuntimeEvent {
  return {
    ...runtimeTextEvent('prior-usage', 'turn-0', 'model', ''),
    id: 'prior-usage',
    runId: 'run-0',
    invocationId: 'run-0',
    role: 'system',
    author: 'system',
    content: undefined,
    actions: { tokenUsage: { input: 30_100, output: 30, lastRequestAnchor } },
  };
}

function priorRunHeader(): AgentRunHeader {
  return {
    runId: 'run-0',
    invocationId: 'run-0',
    sessionId: 'session-1',
    turnId: 'turn-0',
    status: 'completed',
    backendKind: 'ai-sdk',
    llmConnectionId: 'test-connection-id',
    llmConnectionSlug: 'anthropic-main',
    modelId: 'mock-model-id',
    cwd: '/tmp/maka',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
  };
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
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionId: 'test-connection-id',
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
