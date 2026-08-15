import type { ModelCallCommit } from '@maka/core/agent-run';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setImmediate as flushMacrotask } from 'node:timers/promises';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionHeader } from '@maka/core/session';
import type { SessionEvent } from '@maka/core/events';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { AgentBackend, BackendSendInput } from '@maka/core/backend-types';
import { z } from 'zod';
import { AiSdkBackend } from '../ai-sdk-backend.js';
import { buildDefaultContextBudgetPolicy } from '../context-budget-policy.js';
import {
  AiSdkFlow,
  createSessionEventMapMemory,
  mapSessionEventToRuntimeEvent,
} from '../ai-sdk-flow.js';
import type { InvocationContext } from '../invocation-context.js';
import { applyRuntimeEventContextBudget } from '../context-budget.js';
import { evaluateHistoryCompactCheckpointReplay } from '../history-compact.js';
import type { HistoryCompactCheckpoint } from '../history-compact-checkpoint.js';
import type { ContextBudgetDiagnostic } from '@maka/core/usage-stats/types';
import { HistoryCompactSummarizerError } from '../history-compact-error.js';
import { buildLlmHistorySummarizer } from '../history-compact-summarizer.js';
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

interface MidTurnFixture {
  backend: AiSdkBackend;
  model: MockLanguageModelV4;
  recorded: HistoryCompactCheckpoint[];
  recordedBeforeThirdRequest: () => boolean;
  toolExecutions: string[];
  summarizerCalls: number;
  priorEvents: RuntimeEvent[];
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
  /**
   * Derive the policy from the runtime default (buildDefaultContextBudgetPolicy)
   * instead of the hand-built one, so a test can exercise the shipped default.
   */
  useRuntimeDefaultPolicy?: boolean;
  /** Exercise the supported explicit history-compaction escape hatch. */
  historyCompactOff?: boolean;
  historyBudgetTokens?: number;
  reserveTokens?: number;
  summarize?: () => Promise<string | undefined> | string | undefined;
  branch?: string;
  /** Omit the prior turns so the compaction pool has no safe completed span. */
  withoutPriorTurns?: boolean;
  /** Enable the default-on active tool-result prune with a tiny threshold. */
  activeToolResultPrune?: boolean;
  /** Enable semantic compaction so it competes with the capacity hook. */
  semanticCompact?: boolean;
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
  priorShape?: 'text' | 'tool_heavy';
  /** First tool result is huge (finding C: prune must be able to rescue it). */
  hugeFirstResult?: boolean;
  /** The model finishes on the second request instead of running three steps. */
  finalAtSecondCall?: boolean;
  /** Add a third tool step whose result outgrows even a rolled-forward fold (finding A). */
  rollingOverflow?: boolean;
  /** Economy tool availability with a huge-schema group behind load_tools (finding D). */
  bigToolGroup?: boolean;
  /** The first step emits assistant text before its tool call (finding B). */
  assistantTextInFirstStep?: boolean;
  /** Override the first step's reported usage; 'missing' = empty usage object. */
  firstStepUsage?: { input: number; output: number } | 'missing';
  /** Volatile per-request turn tail (cwd/task state) appended to the user message. */
  volatileTurnTail?: boolean;
  /** System prompt size sent through the provider's separate system field. */
  systemPromptChars?: number;
  /** Enable and capture automatic Memory extraction without allowing it to settle. */
  captureMemoryExtraction?: boolean;
  memoryGate?:
    | { readonly allowed: true }
    | { readonly allowed: false; readonly reason: 'disabled' | 'incognito' | 'unavailable' };
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
  const contextWindow = options.contextWindow ?? 2_000;
  const reserveTokens = options.reserveTokens ?? 1_500;
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
    // A usage object the SDK accepts but whose token counts are absent — the
    // adapter's normalization fails closed (undefined) and the capacity hook's
    // usability check must fall back to cold start (the finding-1 shape).
    if (options.firstStepUsage === 'missing')
      return { inputTokens: {}, outputTokens: {} } as ReturnType<typeof usage>;
    if (options.firstStepUsage)
      return usage(options.firstStepUsage.input, options.firstStepUsage.output);
    return usage(100, 20);
  };
  const toolCallChunks = (id: string, name: string, args: object): LanguageModelV4StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(args) },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: id === 'tool-1' ? firstStepUsage() : usage(150, 30),
    },
  ];
  const doneChunks = (): LanguageModelV4StreamPart[] => [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'done' },
    { type: 'text-end', id: 'text-1' },
    { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(120, 10) },
  ];
  const chunksForCall = (call: number): LanguageModelV4StreamPart[] => {
    if (options.bigToolGroup) {
      return call === 1 ? toolCallChunks('tool-1', 'load_tools', { group: 'big' }) : doneChunks();
    }
    if (call === 1) {
      const first = toolCallChunks('tool-1', 'Read', { path: 'one.md' });
      if (!options.assistantTextInFirstStep) return first;
      return [
        first[0]!,
        { type: 'text-start', id: 'step1-text' },
        { type: 'text-delta', id: 'step1-text', delta: 'ASSISTANT_SENTINEL step one reasoning' },
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
        stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
      };
    },
  });
  const priorChars = options.priorChars ?? 120;
  const priorEvents: RuntimeEvent[] = options.withoutPriorTurns
    ? []
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
  const anchor: RuntimeEvent = {
    ...runtimeTextEvent('anchor-1', 'turn-1', 'user', ANCHOR_TEXT),
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
  };

  // The fixture's durable run ledger: the consumer persists every non-partial
  // mapped RuntimeEvent exactly the way AgentRun.acceptMappedEvent does (same
  // mapper, same InvocationContext incl. branch), and the durable-read seam
  // serves it back after pending consumer work has flushed.
  const ledger: RuntimeEvent[] = [anchor];
  const ledgerCtx: InvocationContext = {
    sessionId: 'session-1',
    invocationId: 'run-1',
    runId: 'run-1',
    turnId: 'turn-1',
    ...(options.branch !== undefined ? { branch: options.branch } : {}),
    source: 'desktop',
    startedAt: 1,
    request: { sessionId: 'session-1', turnId: 'turn-1', text: ANCHOR_TEXT, source: 'desktop' },
    newId: idGenerator(),
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
      content: [{ type: 'text', text: 'MID_TURN_SUMMARY_SENTINEL' }],
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
    header: header(),
    appendMessage: async (message) => {
      messages.push(message);
    },
    connection: {
      ...connection(),
      models: [{ id: 'mock-model-id', ...(options.withoutContextWindow ? {} : { contextWindow }) }],
    },
    apiKey: 'sk-test',
    modelId: 'mock-model-id',
    modelFactory: () => model,
    tools: [
      {
        name: 'Read',
        description: 'Read description',
        parameters: z.object({ path: z.string() }),
        impl: async (args: { path: string }) => {
          toolExecutions.push(args.path);
          if (args.path === 'one.md')
            return { body: options.hugeFirstResult ? HUGE_RESULT : RAW_SPAN_ONE };
          if (args.path === 'three.md') return { body: ROLLING_TAIL };
          return { body: RAW_SPAN_TWO };
        },
      },
      ...(options.bigToolGroup
        ? [
            {
              name: 'Big',
              // A same-turn load_tools activation adds this schema to every later
              // request; the trigger must count it (finding D).
              description: `BIG_SCHEMA ${'D'.repeat(12_000)}`,
              parameters: z.object({ q: z.string() }),
              impl: async () => ({ ok: true }),
            },
          ]
        : []),
    ],
    ...(options.bigToolGroup
      ? { toolAvailability: { economy: true, groups: [{ id: 'big', toolNames: ['Big'] }] } }
      : {}),
    ...(options.volatileTurnTail
      ? { turnTailPrompt: 'VOLATILE_TAIL_SENTINEL cwd=/tmp/maka task=keep-going' }
      : {}),
    ...(options.systemPromptChars ? { systemPrompt: 'S'.repeat(options.systemPromptChars) } : {}),
    contextBudget: options.useRuntimeDefaultPolicy
      ? buildDefaultContextBudgetPolicy(
          {
            ...connection(),
            models: [
              { id: 'mock-model-id', ...(options.withoutContextWindow ? {} : { contextWindow }) },
            ],
          },
          {
            name: 'runtime-default-mid-turn',
            modelId: 'mock-model-id',
            // Every value is the shipped runtime default (including the
            // default-on midTurn derivation and the window-bounded reserve
            // under test); a test may still size the reserve to its toy window
            // through the first-class env knob by passing reserveTokens.
            env: {
              ...(options.reserveTokens !== undefined
                ? {
                    MAKA_CONTEXT_HISTORY_COMPACT_RESERVE_TOKENS: String(options.reserveTokens),
                  }
                : {}),
              ...(options.historyCompactOff ? { MAKA_CONTEXT_HISTORY_COMPACT: 'off' } : {}),
              ...(options.historyBudgetTokens !== undefined
                ? { MAKA_CONTEXT_HISTORY_BUDGET_TOKENS: String(options.historyBudgetTokens) }
                : {}),
            },
          },
        )
      : {
          name: 'mid-turn-test',
          maxHistoryEstimatedTokens: 100_000,
          minRecentTurns: 1,
          historyCompact: {
            enabled: true,
            mode: 'read_write',
            midTurn: { enabled: true, reserveTokens },
          },
          ...(options.activeToolResultPrune
            ? { activeToolResultPrune: { enabled: true, maxCurrentResultEstimatedTokens: 30 } }
            : {}),
          ...(options.semanticCompact
            ? {
                semanticCompact: {
                  enabled: true,
                  mode: 'replace' as const,
                  minStepNumber: 2,
                  maxActiveEstimatedTokens: 1,
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
      const summary = options.summarize ? await options.summarize() : 'MID_TURN_SUMMARY_SENTINEL';
      return summary;
    },
    ...(options.meteredSummarizer
      ? {
          recordProviderRequestCapture: async () => ({ artifactId: 'artifact-mid-turn-capture' }),
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
            remember: async () => ({ status: 'unavailable' as const, requestedItems: [] }),
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
  test('compacts over the high water, persists first, and continues the same turn', async () => {
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
    assert.deepEqual(checkpoint.headAnchor, { runtimeEventId: 'anchor-1', turnId: 'turn-1' });
    // Coverage: [prior-user, prior-model, anchor, call-1, result-1] — all of
    // them durable in the ledger before the checkpoint was recorded.
    assert.equal(checkpoint.coverage.eventCount, 5);

    // The next step's prompt is [compact block, verbatim head anchor, preserved tail].
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

    // Invariant: a persisted checkpoint always passes the single replay gate
    // under the same policy the backend replays with — the next projection
    // selects it (no coverage_miss, no size rejection).
    const fit = evaluateHistoryCompactCheckpointReplay(
      checkpoint,
      fixture.ledger,
      undefined,
      100_000,
    );
    assert.equal(fit.fits, true);
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
    // same InvocationContext (incl. branch) as AiSdkFlow.
    for (const event of fixture.ledger) {
      assert.equal(event.branch, 'lane-7');
    }

    // Recovery: re-project prior turns + the durable current-turn ledger with
    // normal thresholds — the checkpoint replays and the covered raw span is
    // never re-injected, even though the raw history is below the high water.
    const replay = applyRuntimeEventContextBudget([...fixture.priorEvents, ...fixture.ledger], {
      maxHistoryEstimatedTokens: 100_000,
      minRecentTurns: 1,
      historyCompact: { enabled: true, mode: 'read_write', checkpoint },
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

  test('ends the turn with context_budget_exhausted when over the window with no safe span', async () => {
    // No prior turns and a window the first step's usage already exceeds: the
    // pool is [anchor, one open call/result pair], so no safe completed span.
    const fixture = buildFixture({
      contextWindow: 120,
      reserveTokens: 100,
      withoutPriorTurns: true,
    });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'no_safe_completed_span');
    // Explicit outcome, not a raw provider error.
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
    // The over-budget request was aborted before it could stream (the second
    // doStream attempt sees an already-aborted signal and rejects).
    assert.equal(fixture.model.doStreamCalls.length <= 2, true);
    assert.equal(
      fixture.events.some(
        (event) =>
          event.type === 'tool_start' &&
          event.toolName === 'Read' &&
          JSON.stringify(event.args).includes('two.md'),
      ),
      false,
    );
  });

  test('ends the turn with summarizer_failed detail when over the window and the summary fails', async () => {
    // Estimate at the first boundary ≈ 120 real usage + result chars/4 ≈ 200;
    // window 150 puts it over the hard cap while priors leave a safe span.
    const fixture = buildFixture({
      contextWindow: 150,
      reserveTokens: 100,
      summarize: () => {
        throw new Error('summarizer down');
      },
    });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'summarizer_failed');
  });

  test('ends the turn with head_anchor_exceeds_capacity when even the minimal projection cannot fit', async () => {
    // Big priors leave a safe span, the summary succeeds, and the fold
    // GENUINELY shrinks the payload — but the last request's real input
    // (1400 tokens) is so large that even the [block, anchor, open pair]
    // projection stays over the 150-token window: the irreducible remainder
    // exceeds capacity. (A non-shrinking fold is a different failure —
    // summarizer_failed via replacement_not_smaller.)
    const fixture = buildFixture({
      contextWindow: 150,
      reserveTokens: 100,
      priorChars: 2_000,
      firstStepUsage: { input: 1_400, output: 20 },
    });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'head_anchor_exceeds_capacity');
    // The fold itself was valid and durable; it just could not rescue.
    assert.equal(fixture.recorded.length, 1);
  });

  test('fails open with write_failed diagnostics when the checkpoint write fails under the window', async () => {
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
    // The recorder WAS invoked and failed: exactly that is what the counters say.
    const usageEvent = fixture.events.find((event) => event.type === 'token_usage') as
      | { contextBudget?: ContextBudgetDiagnostic }
      | undefined;
    assert.equal(usageEvent?.contextBudget?.historyCompactWritesAttempted, 1);
    assert.equal(usageEvent?.contextBudget?.historyCompactWriteFailures, 1);
  });

  test('exhausts with write_failed in the durable diagnostics when the write fails over the window', async () => {
    // Big priors make folding rescue the over-window estimate, so the plan
    // compacts and the failure happens AT the recorder — over the window that
    // is the explicit exhausted outcome, and the durable diagnostics must
    // carry write_failed even though the terminal enum has no write member.
    const fixture = buildFixture({
      contextWindow: 150,
      reserveTokens: 100,
      priorChars: 2_000,
      record: () => {
        throw new Error('disk full');
      },
    });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'summarizer_failed');

    const lastCall = fixture.llmCalls.at(-1);
    const exhaustedDecision = (lastCall?.contextBudget?.compactionDecisions ?? []).find(
      (decision) => decision.phase === 'mid_turn' && decision.reason === 'context_budget_exhausted',
    );
    assert.equal(exhaustedDecision?.skippedReasonCounts?.write_failed, 1);
    assert.equal(lastCall?.contextBudget?.historyCompactWritesAttempted, 1);
    assert.equal(lastCall?.contextBudget?.historyCompactWriteFailures, 1);
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

  test('semantic compaction yields on the step the capacity hook replaced', async () => {
    const fixture = buildFixture({ semanticCompact: true });
    await runFixtureTurn(fixture, consumer);

    // The capacity projection won the replaced step.
    assert.equal(fixture.model.doStreamCalls.length, 3);
    assert.equal(fixture.recorded.length, 1);
    assert.match(promptJson(fixture, 2), /maka_history_compact_checkpoint/);

    // Deterministic priority: semantic compaction was skipped for that step
    // with an explicit decision — one step never runs two summarizers.
    const yielded = compactionDecisions(fixture).find(
      (decision) => decision.reason === 'mid_turn_capacity_precedence',
    );
    assert.equal(yielded?.decision, 'unchanged');
    assert.equal(fixture.summarizerCalls, 1);
    // No semantic summary model call was ever made.
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
  });

  test('a rolling second compaction that still exceeds the window ends explicitly (review finding A)', async () => {
    // Review round-3 finding A: the old post-fold re-estimate subtracted the
    // RAW covered span from a usage estimate anchored to the ALREADY-compacted
    // previous request, over-crediting the second fold and letting a
    // still-over-window request stream. The final-payload owner measures the
    // real replacement projection instead: the third step's huge result makes
    // even [second block, anchor, tail] exceed the window, so the turn must
    // end with the explicit outcome — never send the over-window request.
    const fixture = buildFixture({ priorChars: 2_000, rollingOverflow: true });
    await runFixtureTurn(fixture, consumer);

    // The first fold happened and its projection was used (three requests ran).
    assert.equal(fixture.recorded.length, 2);
    assert.equal(fixture.recorded[0]?.phase, 'mid_turn');
    // The second fold rolled forward from the first checkpoint...
    assert.equal(fixture.recorded[1]?.previousCheckpointId, fixture.recorded[0]?.checkpointId);
    // ...but its replacement still exceeds the window: explicit outcome.
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'head_anchor_exceeds_capacity');
    // The over-window fourth request never streamed.
    assert.equal(
      fixture.events.some((event) => event.type === 'text_complete' && event.text === 'done'),
      false,
    );
  });

  test('an aborted multi-step send records the accumulated usage of the completed steps', async () => {
    // The terminal LLM-call record is fail-closed on usage evidence (#972),
    // and an aborted send may never resolve the SDK's final usage promise. But
    // every COMPLETED step reported real usage at its finish-step boundary,
    // so the terminal record must carry that accumulated sum — the capacity
    // verdict diagnostics ride this record and the completed steps' cost is
    // real. Three steps stream (100/20 + 150/30 + 150/30) before the step-4
    // verdict aborts the send.
    const fixture = buildFixture({ priorChars: 2_000, rollingOverflow: true });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(
      complete?.type === 'complete' ? complete.stopReason : undefined,
      'context_budget_exhausted',
    );
    // Three requests streamed; the fourth is rejected locally before the
    // provider adapter is called and therefore reports no usage.
    assert.equal(fixture.model.doStreamCalls.length, 3);
    const lastCall = fixture.llmCalls.at(-1);
    assert.equal(lastCall?.status, 'error');
    assert.equal(lastCall?.errorClass, 'ContextBudgetExhausted');
    assert.equal(lastCall?.inputTokens, 400);
    assert.equal(lastCall?.outputTokens, 80);
    assert.equal(lastCall?.totalTokens, 480);
  });

  test('an unusable completed-step usage sample fails the whole record closed — no partial sum (review round-7)', async () => {
    // #972 semantics: incomplete usage evidence fails closed. The first
    // completed step's usage is unusable (normalization returns undefined),
    // so the sum of the remaining steps (150/30 + 150/30) is a PARTIAL cost.
    // LlmCallRecord has no partial marker — downstream reads any record as
    // the whole call — so the truthful outcome is no record at all; the
    // terminal result stays observable on the durable CompleteEvent.
    const fixture = buildFixture({
      priorChars: 2_000,
      rollingOverflow: true,
      firstStepUsage: 'missing',
    });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(
      complete?.type === 'complete' ? complete.stopReason : undefined,
      'context_budget_exhausted',
    );
    assert.equal(fixture.llmCalls.length, 0);
  });

  test('the verdict is issued after pruning — a prune-rescuable step is not exhausted (review finding C)', async () => {
    // Review round-3 finding C repro: one huge tool result, no safe completed
    // span for the capacity hook, but the active tool-result prune (which runs
    // AFTER the capacity hook) archives the result down to a placeholder that
    // fits the window. A verdict inside the capacity hook would have declared
    // context_budget_exhausted before the rescue could run.
    const fixture = buildFixture({
      contextWindow: 500,
      reserveTokens: 100,
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

  test('the trigger counts same-turn tool-schema growth from load_tools (review finding D)', async () => {
    // Review round-3 finding D repro: the model activates a ~12.7k-char tool
    // group mid-turn. The schema lands in every later request, so the payload
    // estimate must count it: the next request cannot fit the 500-token window
    // and the pool has no safe completed span, so the turn ends explicitly
    // instead of streaming a ~3k-token request into a 500-token window.
    const fixture = buildFixture({
      contextWindow: 500,
      reserveTokens: 100,
      withoutPriorTurns: true,
      bigToolGroup: true,
    });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'no_safe_completed_span');
    // The over-window second request never streamed the expanded schema.
    assert.equal(
      fixture.events.some((event) => event.type === 'text_complete' && event.text === 'done'),
      false,
    );
  });

  test('a fold that cannot shrink the real payload is refused, not applied (runaway summary)', async () => {
    // The summarizer returns a block far larger than the span it replaces.
    // Applying it would hand the verdict owner a WORSE request than the raw
    // projection; the hook measures the materialized payload and keeps the raw
    // messages instead. Validation runs before the recorder, so the rejected
    // checkpoint is never persisted (asserted below).
    const fixture = buildFixture({ summarize: () => 'GIANT_SUMMARY_'.repeat(600) });
    await runFixtureTurn(fixture, consumer);

    assert.equal(fixture.model.doStreamCalls.length, 3);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    // The raw span stayed; the giant block was never sent.
    const thirdPrompt = promptJson(fixture, 2);
    assert.equal(thirdPrompt.includes('RAW_SPAN_ONE_'), true);
    assert.equal(thirdPrompt.includes('GIANT_SUMMARY_'), false);
    const failedOpen = compactionDecisions(fixture).find(
      (decision) => decision.phase === 'mid_turn' && decision.decision === 'failedOpen',
    );
    assert.equal(failedOpen?.failOpenReason, 'replacement_not_smaller');
    // Review round-4 finding 3: a checkpoint whose replacement was REJECTED
    // must never be persisted — replay applies the session's latest checkpoint
    // before any high-water check, so a persisted runaway block would poison
    // every later projection even though this step correctly refused it.
    assert.equal(fixture.recorded.length, 0);
    // The recorder was never reached, so the diagnostics claim no write.
    const usageEvent = fixture.events.find((event) => event.type === 'token_usage') as
      | { contextBudget?: ContextBudgetDiagnostic }
      | undefined;
    assert.equal(usageEvent?.contextBudget?.historyCompactWritesAttempted, undefined);
  });

  test("the usage baseline is the last request's INPUT tokens — output is not double-counted (review finding 1)", async () => {
    // Review round-4 finding 1 repro shape: a step with heavy output. The
    // signed payload delta already carries the freshly generated assistant
    // output and tool results, so a baseline of input+output counts the
    // output twice (~500 real tokens estimated as ~900) and terminates a
    // turn that actually fits the window.
    const fixture = buildFixture({
      contextWindow: 500,
      reserveTokens: 100,
      withoutPriorTurns: true,
      finalAtSecondCall: true,
      firstStepUsage: { input: 300, output: 380 },
    });
    await runFixtureTurn(fixture, consumer);

    // input(300) + payload delta (~hundred tokens) fits the 500 window; the
    // double-counting baseline (680 + delta) would have exhausted it.
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    assert.equal(fixture.model.doStreamCalls.length, 2);
  });

  test('a usage object without usable input tokens falls back to cold start, never to zero (review finding 1)', async () => {
    // Reverse direction: the adapter normalizes missing token fields to 0. A
    // zero baseline plus a small delta estimates a huge request as tiny and
    // lets it stream over the window; an unusable usage sample must instead
    // fall back to the whole-payload cold-start estimate, which triggers the
    // fold here (big priors leave a safe span, so compaction rescues).
    const fixture = buildFixture({
      contextWindow: 1_000,
      reserveTokens: 100,
      priorChars: 2_000,
      finalAtSecondCall: true,
      firstStepUsage: 'missing',
    });
    await runFixtureTurn(fixture, consumer);

    assert.equal(fixture.recorded.length, 1);
    const secondPrompt = promptJson(fixture, 1);
    assert.match(secondPrompt, /maka_history_compact_checkpoint/);
    assert.equal(secondPrompt.includes('PRIOR_FACT'), false);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
  });

  test('the volatile turn tail survives a capacity replacement (review finding 2)', async () => {
    // The initial provider user message decorates the durable anchor text
    // with a volatile turn tail (cwd, shell context, task state). The
    // replacement projection is materialized from the ledger, where the
    // anchor holds only the raw user text — the rendering must go through
    // the same decoration owner or compaction silently drops that context
    // (and even counts the drop as shrinkage).
    const fixture = buildFixture({ volatileTurnTail: true });
    await runFixtureTurn(fixture, consumer);

    assert.equal(fixture.recorded.length, 1);
    const thirdPrompt = promptJson(fixture, 2);
    assert.match(thirdPrompt, /maka_history_compact_checkpoint/);
    assert.equal(thirdPrompt.includes(ANCHOR_TEXT), true);
    assert.equal(thirdPrompt.includes('VOLATILE_TAIL_SENTINEL'), true);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
  });

  test('an over-window runaway summary terminates as summarizer_failed, not head_anchor_exceeds_capacity (review finding 4)', async () => {
    // A non-shrinking replacement proves the summarizer's output is unusable,
    // not that the irreducible remainder (anchor + tail + overhead) exceeds
    // capacity — the terminal detail must say so; the diagnostic reason keeps
    // the precise replacement_not_smaller cause.
    const fixture = buildFixture({
      contextWindow: 150,
      reserveTokens: 100,
      summarize: () => 'GIANT_SUMMARY_'.repeat(600),
    });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'summarizer_failed');
    const lastCall = fixture.llmCalls.at(-1);
    const exhaustedDecision = (lastCall?.contextBudget?.compactionDecisions ?? []).find(
      (decision) => decision.phase === 'mid_turn' && decision.reason === 'context_budget_exhausted',
    );
    assert.equal(exhaustedDecision?.skippedReasonCounts?.replacement_not_smaller, 1);
    // The rejected checkpoint was never persisted.
    assert.equal(fixture.recorded.length, 0);
  });

  test('the cold-start estimate covers the FULL provider input including the system prompt (review round-5 finding 2)', async () => {
    // The system prompt travels in the separate `system` field, not in
    // messages. With usage missing, a cold-start estimate over messages+tools
    // alone (~2150 tokens) stays under the 2900 high water and lets a real
    // ~3650-token request stream into a 3000-token window. The single payload
    // measure must include the system prompt: constant between adjacent
    // requests (signed deltas unaffected), decisive for cold start.
    const fixture = buildFixture({
      contextWindow: 3_000,
      reserveTokens: 100,
      withoutPriorTurns: true,
      hugeFirstResult: true,
      finalAtSecondCall: true,
      firstStepUsage: 'missing',
      systemPromptChars: 6_000,
    });
    await runFixtureTurn(fixture, consumer);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'no_safe_completed_span');
    // The over-window second request never streamed.
    assert.equal(
      fixture.events.some((event) => event.type === 'text_complete' && event.text === 'done'),
      false,
    );
    // Every completed step's usage was unusable, so there is no usage
    // evidence at all: the fail-closed terminal record is skipped and the
    // exhausted outcome is observable only through the CompleteEvent above.
    assert.equal(fixture.llmCalls.length, 0);
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
      reserveTokens: 1_900,
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
    const fixture = buildFixture({ captureMemoryExtraction: true, systemPromptChars: 32 });
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

describe('mid-turn capacity compaction flow plumbing', () => {
  test('AiSdkFlow forwards the persisted head anchor to backend.send', async () => {
    const sendInputs: BackendSendInput[] = [];
    const anchor = runtimeTextEvent('anchor-1', 'turn-1', 'user', ANCHOR_TEXT);
    const fakeBackend: AgentBackend = {
      kind: 'ai-sdk',
      sessionId: 'session-1',
      // eslint-disable-next-line @typescript-eslint/require-await
      async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
        sendInputs.push(input);
        yield {
          type: 'complete',
          id: 'complete-1',
          turnId: input.turnId,
          ts: 2,
          stopReason: 'end_turn',
        };
      },
      stop: async () => {},
      respondToSandboxBoundary: async () => {},
      dispose: async () => {},
    };
    const flow = new AiSdkFlow({ backend: fakeBackend });
    const ctx: InvocationContext = {
      sessionId: 'session-1',
      invocationId: 'run-1',
      runId: 'run-1',
      turnId: 'turn-1',
      branch: 'lane-7',
      source: 'desktop',
      startedAt: 1,
      request: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        text: 'hello',
        source: 'desktop',
        initialRuntimeEvent: anchor,
      },
      newId: idGenerator(),
      now: monotonicClock(),
    };
    for await (const _event of flow.run(ctx, { text: 'hello', context: [] })) {
      // drain
    }
    assert.equal(sendInputs.length, 1);
    assert.equal(sendInputs[0]?.headAnchorRuntimeEvent, anchor);
  });
});

describe('mid-turn capacity default-on safety guards (issue #882 PR 3)', () => {
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

  test('compacts one oversized prior turn before an unknown-model request', async () => {
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      withoutContextWindow: true,
      priorChars: 180_000,
      priorShape: 'tool_heavy',
    });
    await runFixtureTurn(fixture);

    assert.equal(fixture.summarizerCalls, 1);
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]?.coverage.eventCount, 4);
    assert.match(fixture.summarizedSources[0] ?? '', /function_call/);
    assert.match(fixture.summarizedSources[0] ?? '', /function_response/);
    const firstPrompt = promptJson(fixture, 0);
    assert.match(firstPrompt, /maka_history_compact_checkpoint/);
    assert.match(firstPrompt, /MID_TURN_SUMMARY_SENTINEL/);
    assert.equal(firstPrompt.includes('OVERSIZED_TOOL_RESULT_'), false);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
  });

  test('rejects one oversized prior turn locally when its summary fails', async () => {
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      withoutContextWindow: true,
      priorChars: 180_000,
      priorShape: 'tool_heavy',
      summarize: () => undefined,
    });
    await runFixtureTurn(fixture);

    assert.equal(fixture.summarizerCalls, 1);
    assert.equal(fixture.model.doStreamCalls.length, 0);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'summarizer_failed');
  });

  test('compacts an oversized latest turn when an older turn is also retained', async () => {
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      withoutContextWindow: true,
      priorChars: 180_000,
      priorShape: 'tool_heavy',
    });
    fixture.priorEvents.unshift(
      runtimeTextEvent('older-user', 'turn-older', 'user', 'older question'),
      runtimeTextEvent('older-model', 'turn-older', 'model', 'older answer'),
    );
    await runFixtureTurn(fixture);

    assert.equal(fixture.summarizerCalls, 1);
    assert.equal(fixture.recorded.length, 1);
    assert.equal(promptJson(fixture, 0).includes('OVERSIZED_TOOL_RESULT_'), false);
  });

  test('rejects an oversized prior turn when history compaction is disabled', async () => {
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      withoutContextWindow: true,
      historyCompactOff: true,
      priorChars: 180_000,
      priorShape: 'tool_heavy',
    });
    await runFixtureTurn(fixture);

    assert.equal(fixture.summarizerCalls, 0);
    assert.equal(fixture.model.doStreamCalls.length, 0);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'no_safe_completed_span');
  });

  test('rejects an oversized penultimate turn when history compaction is disabled', async () => {
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      withoutContextWindow: true,
      historyCompactOff: true,
      priorChars: 180_000,
      priorShape: 'tool_heavy',
    });
    fixture.priorEvents.push(
      runtimeTextEvent('latest-user', 'turn-latest', 'user', 'small latest question'),
      runtimeTextEvent('latest-model', 'turn-latest', 'model', 'small latest answer'),
    );
    await runFixtureTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 0);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'no_safe_completed_span');
  });

  test('keeps multiple bounded recent turns when only their aggregate exceeds the history budget', async () => {
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      contextWindow: 100_000,
      historyCompactOff: true,
      historyBudgetTokens: 32_000,
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

  test('rejects an oversized complete step-zero payload before provider dispatch', async () => {
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      withoutContextWindow: true,
      systemPromptChars: 200_000,
    });
    await runFixtureTurn(fixture);

    assert.equal(fixture.model.doStreamCalls.length, 0);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'no_safe_completed_span');
  });

  test('keeps user_stop when stopping an oversized pre-turn summary', async () => {
    let markSummaryStarted: (() => void) | undefined;
    const summaryStarted = new Promise<void>((resolve) => {
      markSummaryStarted = resolve;
    });
    let finishSummary: (() => void) | undefined;
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      withoutContextWindow: true,
      priorChars: 180_000,
      priorShape: 'tool_heavy',
      summarize: () =>
        new Promise<undefined>((resolve) => {
          finishSummary = () => resolve(undefined);
          markSummaryStarted?.();
        }),
    });
    const turn = runFixtureTurn(fixture);
    await summaryStarted;
    await fixture.backend.stop('user_stop');
    finishSummary?.();
    await turn;

    assert.equal(fixture.model.doStreamCalls.length, 0);
    assert.equal(
      fixture.events.some((event) => event.type === 'abort'),
      true,
    );
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'user_stop');
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

  test('never runs a pointless summarizer on a small-window model under the shipped defaults (review P2)', async () => {
    // gpt-4 shape: an 8192-token window under the runtime-derived defaults.
    // A flat 16384 reserve used to clamp the mid_turn high water to 1 token —
    // every boundary triggered, the summarizer ran, and the checkpoint could
    // never pass the 1-token replay gate: pure waste. With the window-bounded
    // reserve the payload sits far below the high water, so the default must
    // be completely inert here: no summarizer call, no checkpoint, and the
    // turn completes on the raw projection.
    const fixture = buildFixture({ useRuntimeDefaultPolicy: true, contextWindow: 8_192 });
    await runFixtureTurn(fixture);

    assert.equal(fixture.summarizerCalls, 0);
    assert.equal(fixture.recorded.length, 0);
    assert.equal(fixture.model.doStreamCalls.length, 3);
    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type === 'complete' ? complete.stopReason : undefined, 'end_turn');
    assert.equal(promptJson(fixture, 2).includes('RAW_SPAN_ONE_'), true);
  });
});

describe('the shipped runtime default drives the proactive long-turn journey (issue #882 PR 3)', () => {
  test('a long turn near the window compacts mid-turn, persists the checkpoint, and continues instead of truncating', async () => {
    // No hand-built policy and no env override: this wires
    // buildDefaultContextBudgetPolicy — the exact default every surface now
    // inherits — into the backend. A long turn whose real usage crosses
    // `contextWindow - derivedReserve` (window 1000 → reserve 250, high water
    // 750) must fold a safe completed prefix into a DURABLE mid_turn
    // checkpoint and continue the SAME turn to normal completion, never
    // truncate it or surface a raw provider error.
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      contextWindow: 1_000,
      priorChars: 1_400,
      firstStepUsage: { input: 900, output: 20 },
    });
    await runFixtureTurn(fixture);

    // The checkpoint was durably persisted (not a fail-open raw continuation).
    assert.equal(fixture.recorded.length, 1);
    assert.equal(fixture.recorded[0]?.phase, 'mid_turn');
    // The continued request rides the compacted projection: the compact block
    // is present and the replaced raw span is gone.
    const continuedPrompt = promptJson(fixture, 1);
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

  test('an unrescuable turn under the shipped default ends with the explicit context_budget_exhausted outcome', async () => {
    // Same runtime-derived default (window 120 → reserve 30, high water 90):
    // no prior turns leaves no safe completed span, and the request genuinely
    // exceeds the window — the turn must end with the first-class outcome, not
    // a raw provider error.
    const fixture = buildFixture({
      useRuntimeDefaultPolicy: true,
      contextWindow: 120,
      withoutPriorTurns: true,
    });
    await runFixtureTurn(fixture);

    const complete = fixture.events.find((event) => event.type === 'complete');
    assert.equal(complete?.type, 'complete');
    if (complete?.type !== 'complete') return;
    assert.equal(complete.stopReason, 'context_budget_exhausted');
    assert.equal(complete.contextBudgetExhaustedDetail, 'no_safe_completed_span');
    assert.equal(
      fixture.events.some((event) => event.type === 'error'),
      false,
    );
  });
});

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
