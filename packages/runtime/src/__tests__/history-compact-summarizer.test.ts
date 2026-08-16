import type { ModelCallCommit } from '@maka/core/agent-run';
/**
 * Tests for buildLlmHistorySummarizer — the AI-SDK-backed LLM summary that
 * replaces the deterministic excerpt draft when wiring injects it.
 *
 * Run: `npm --workspace @maka/runtime run test`
 */
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '../test-helpers.js';
import type { RuntimeEvent, RuntimeEventContent } from '@maka/core/runtime-event';
import { decodeModelCallAttempt, type ModelCallAttempt } from '@maka/core/model-call-attempt';
import { ProviderRequestTracker } from '../provider-request-telemetry.js';
import type { HistoryCompactSummaryInput } from '../ai-sdk-compaction-contract.js';
import {
  buildLlmHistorySummarizer,
  HistoryCompactSummarizerError,
  type AiSdkGenerateTextLike,
} from '../history-compact-summarizer.js';
import { buildHistoryCompactCheckpoint } from '../history-compact-checkpoint.js';

const ts = 1_700_000_000_000;
let __seq = 0;
function ev(overrides: Partial<RuntimeEvent> & { content?: RuntimeEventContent }): RuntimeEvent {
  __seq += 1;
  return {
    id: `evt-${__seq}`,
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: ts + __seq,
    partial: false,
    ...overrides,
  } as RuntimeEvent;
}

function inputWith(events: RuntimeEvent[], abortSignal?: AbortSignal): HistoryCompactSummaryInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    source: { foldedRuntimeEvents: events },
    ...(abortSignal ? { abortSignal } : {}),
  };
}

describe('buildLlmHistorySummarizer', () => {
  test('inherits the session provider options without imposing a compaction-only output cap', async () => {
    let seen: Parameters<AiSdkGenerateTextLike>[0] | undefined;
    const providerOptions = { openaiCompatible: { reasoningEffort: 'high' } };
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      providerOptions,
      generateText: async (options) => {
        seen = options;
        return { text: '## Goal\nX' };
      },
    });

    await summarize({
      ...inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      inputBudget: { maxEstimatedTokens: 10_000, charsPerToken: 1 },
    });

    expect(seen?.providerOptions).toBe(providerOptions);
    expect(seen?.maxOutputTokens).toBe(undefined);
  });

  test('attributes provider-reported usage to one canonical history-compaction record', async () => {
    // history_compact used to write a per-call row into the frozen table. It
    // now settles through the same seam as a main send, so the record carries
    // the run it belongs to and its cost basis (#1679).
    const recorded: ModelCallAttempt[] = [];
    let now = 100;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () =>
        new MockLanguageModelV4({
          doGenerate: {
            content: [{ type: 'text', text: '## Goal\nX' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 3, text: 3, reasoning: 0 },
            },
            warnings: [],
          },
        }),
    });

    // The backend hands over a built tracker; the summarizer assembles nothing.
    await summarize({
      ...inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      providerRequestTracker: new ProviderRequestTracker({
        traceId: 'trace-id',
        turnId: 'turn-1',
        now: () => {
          now += 10;
          return now;
        },
        newId: () => 'trace-id',
        persistCapture: async () => ({ artifactId: 'artifact-1' }),
        recordAttempt: () => {},
        accounting: {
          sessionId: 'sess-1',
          resolveRunId: () => 'run-1',
          connectionSlug: 'connection',
          providerId: 'provider',
          callKind: 'history_compact',
          record: ({ attempt }: ModelCallCommit<ModelCallAttempt>) => {
            recorded.push(attempt);
          },
        },
      }),
    });

    const attempt = decodeModelCallAttempt(recorded[0]);
    assert.equal(attempt.callKind, 'history_compact');
    assert.equal(attempt.sessionId, 'sess-1');
    assert.equal(attempt.runId, 'run-1');
    assert.equal(attempt.turnId, 'turn-1');
    assert.equal(attempt.connectionSlug, 'connection');
    assert.equal(attempt.providerId, 'provider');
    assert.equal(attempt.inputTokens, 7);
    assert.equal(attempt.outputTokens, 3);
    assert.equal(attempt.usageBasis, 'reported');
    // No pricing was wired, so the record says the price is unknown rather
    // than claiming the summarization was free.
    assert.equal(attempt.costBasis, 'unpriced');
    assert.equal(attempt.costUsd, undefined);
  });

  test('produces schema-valid tool-result messages (toolName + wrapped output) and does not fall back', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: '## Goal\nX' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: '读 package.json' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc1', name: 'read', args: { path: 'package.json' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc1', name: 'read', result: { name: 'maka' } },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'ok' } }),
    ];

    const result = await summarize(inputWith(events));
    expect(result).toBe('## Goal\nX');

    const messages = seen[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string; toolName?: string; output?: unknown }>;
    }>;
    const toolPart = messages.find((m) => m.role === 'tool')!.content[0]!;
    expect(toolPart.type).toBe('tool-result');
    // toolName must be present in AI SDK tool-result content.
    expect(toolPart.toolName).toBe('read');
    // output must be the {type, value} wrapper, not the raw result object
    expect(toolPart.output).toEqual({ type: 'json', value: { name: 'maka' } });
  });

  test('groups parallel tool calls into one assistant message for strict providers', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: '## Goal\nX' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: '并行读两个文件' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc1', name: 'read', args: { path: 'a.ts' } },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc2', name: 'read', args: { path: 'b.ts' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc1', name: 'read', result: 'A' },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc2', name: 'read', result: 'B' },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'ok' } }),
    ];

    await summarize(inputWith(events));

    const messages = seen[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string; toolCallId?: string }>;
    }>;
    // Both calls of the parallel step share one assistant message; a second
    // assistant message before the first's results is the strict-provider 400
    // in #3030.
    const assistantToolCallMessages = messages.filter(
      (m) => m.role === 'assistant' && m.content.some((part) => part.type === 'tool-call'),
    );
    assert.equal(assistantToolCallMessages.length, 1);
    assert.deepEqual(
      assistantToolCallMessages[0]!.content.map((part) => part.toolCallId),
      ['fc1', 'fc2'],
    );
    const shape = messages.map((m) => `${m.role}:${m.content.map((part) => part.type).join('+')}`);
    assert.deepEqual(shape.slice(-4), [
      'assistant:tool-call+tool-call',
      'tool:tool-result',
      'tool:tool-result',
      'assistant:text',
    ]);
  });

  test('keeps a step open across interleaved results until every call is settled', async () => {
    // The production-legal ordering from the primary replay materializer's
    // fixture: call A, call B, result A, call C, result B, result C. All
    // three calls must share one assistant message with the results after it.
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: '## Goal\nX' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'inspect files' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc1', name: 'read', args: { path: 'a.ts' } },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc2', name: 'read', args: { path: 'b.ts' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc1', name: 'read', result: 'A' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc3', name: 'glob', args: { pattern: '*' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc2', name: 'read', result: 'B' },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc3', name: 'glob', result: ['a.ts'] },
      }),
    ];

    await summarize(inputWith(events));

    const messages = seen[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string; toolCallId?: string }>;
    }>;
    const shape = messages.map((m) => `${m.role}:${m.content.map((part) => part.type).join('+')}`);
    assert.deepEqual(shape, [
      'user:text',
      'assistant:tool-call+tool-call+tool-call',
      'tool:tool-result',
      'tool:tool-result',
      'tool:tool-result',
    ]);
    assert.deepEqual(
      messages[1]!.content.map((part) => part.toolCallId),
      ['fc1', 'fc2', 'fc3'],
    );
    assert.deepEqual(
      messages.slice(2).map((m) => m.content[0]!.toolCallId),
      ['fc1', 'fc2', 'fc3'],
    );
  });

  test('does not merge distinct settled steps into one assistant message', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: '## Goal\nX' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const events: RuntimeEvent[] = [
      // Two sequential legacy steps (no stepId): the second call arrives only
      // after the first is fully settled, so it opens its own message.
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc1', name: 'read', args: { path: 'a.ts' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc1', name: 'read', result: 'A' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc2', name: 'read', args: { path: 'b.ts' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc2', name: 'read', result: 'B' },
      }),
    ];

    await summarize(inputWith(events));

    const messages = seen[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string }>;
    }>;
    const shape = messages.map((m) => `${m.role}:${m.content.map((part) => part.type).join('+')}`);
    assert.deepEqual(shape, [
      'assistant:tool-call',
      'tool:tool-result',
      'assistant:tool-call',
      'tool:tool-result',
    ]);
  });

  test('bounds the oldest oversized tool result before dispatch while preserving newer context', async () => {
    let seen: Parameters<AiSdkGenerateTextLike>[0] | undefined;
    const generateText: AiSdkGenerateTextLike = async (options) => {
      seen = options;
      return { text: '## Goal\nX' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });
    const oldToolOutput = 'OLD_OVERSIZED_TOOL_OUTPUT_'.repeat(1_024);
    const events: RuntimeEvent[] = [
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'old-call', name: 'read', args: { path: 'old.log' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'old-call',
          name: 'read',
          result: oldToolOutput,
        },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'recent-call',
          name: 'read',
          args: { path: 'recent.log' },
        },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'recent-call',
          name: 'read',
          result: 'RECENT_TOOL_RESULT',
        },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'LATEST_GROUNDED_CONTEXT' },
      }),
    ];

    await summarize({
      ...inputWith(events),
      inputBudget: { maxEstimatedTokens: 4_000, charsPerToken: 1 },
    });

    const messages = seen!.messages;
    const serialized = JSON.stringify(messages);
    assert.ok(serialized.length <= 4_000);
    assert.equal(serialized.includes(oldToolOutput), false);
    assert.match(serialized, /Tool output omitted/);
    assert.match(serialized, /RECENT_TOOL_RESULT/);
    assert.match(serialized, /LATEST_GROUNDED_CONTEXT/);
    assert.match(JSON.stringify(events), /OLD_OVERSIZED_TOOL_OUTPUT/);
    assert.deepEqual(
      messages.flatMap((message) =>
        typeof message.content === 'string'
          ? []
          : message.content
              .filter((part) => part.type === 'tool-call' || part.type === 'tool-result')
              .map((part) => ({ type: part.type, toolCallId: part.toolCallId })),
      ),
      [
        { type: 'tool-call', toolCallId: 'old-call' },
        { type: 'tool-result', toolCallId: 'old-call' },
        { type: 'tool-call', toolCallId: 'recent-call' },
        { type: 'tool-result', toolCallId: 'recent-call' },
      ],
    );
  });

  test('fails with input_too_large before dispatch when non-tool history cannot fit', async () => {
    let calls = 0;
    let modelResolutions = 0;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => {
        modelResolutions += 1;
        return 'fake-model';
      },
      generateText: async () => {
        calls += 1;
        return { text: 'should not dispatch' };
      },
    });

    await assert.rejects(
      summarize({
        ...inputWith([
          ev({
            role: 'user',
            author: 'user',
            content: { kind: 'text', text: 'x'.repeat(1_000) },
          }),
        ]),
        inputBudget: { maxEstimatedTokens: 10, charsPerToken: 1 },
      }),
      (error) =>
        error instanceof HistoryCompactSummarizerError && error.reason === 'input_too_large',
    );
    assert.equal(calls, 0);
    assert.equal(modelResolutions, 0);
  });

  test('charges the summarization instructions against the input budget before dispatch', async () => {
    let calls = 0;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => {
        calls += 1;
        return { text: 'should not dispatch' };
      },
    });

    await assert.rejects(
      summarize({
        ...inputWith([
          ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'small history' } }),
        ]),
        inputBudget: { maxEstimatedTokens: 500, charsPerToken: 1 },
      }),
      (error) =>
        error instanceof HistoryCompactSummarizerError && error.reason === 'input_too_large',
    );
    assert.equal(calls, 0);
  });

  test('stamped step ids decide membership over settledness', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: '## Goal\nX' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const events: RuntimeEvent[] = [
      // Same stamped step: joins even though fc1 settled before fc2 arrived.
      ev({
        role: 'model',
        author: 'agent',
        refs: { stepId: 'step-1' },
        content: { kind: 'function_call', id: 'fc1', name: 'read', args: { path: 'a.ts' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc1', name: 'read', result: 'A' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        refs: { stepId: 'step-1' },
        content: { kind: 'function_call', id: 'fc2', name: 'read', args: { path: 'b.ts' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc2', name: 'read', result: 'B' },
      }),
      // Different stamped step: never merged into the block above.
      ev({
        role: 'model',
        author: 'agent',
        refs: { stepId: 'step-2' },
        content: { kind: 'function_call', id: 'fc3', name: 'glob', args: { pattern: '*' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc3', name: 'glob', result: [] },
      }),
    ];

    await summarize(inputWith(events));

    const messages = seen[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string; toolCallId?: string }>;
    }>;
    const shape = messages.map((m) => `${m.role}:${m.content.map((part) => part.type).join('+')}`);
    assert.deepEqual(shape, [
      'assistant:tool-call+tool-call',
      'tool:tool-result',
      'tool:tool-result',
      'assistant:tool-call',
      'tool:tool-result',
    ]);
    assert.deepEqual(
      messages[0]!.content.map((part) => part.toolCallId),
      ['fc1', 'fc2'],
    );
  });

  test('surfaces provider failures so the runtime can report the real compact reason', async () => {
    const generateText: AiSdkGenerateTextLike = async () => {
      throw new Error('model down');
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /provider_error/,
    );
  });

  test('surfaces an exhausted output budget instead of reporting a generic empty summary', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: '', finishReason: 'length' }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /output_length/,
    );
  });

  test('rejects non-empty partial text when the provider exhausted its output budget', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: '## Goal\npartial summary', finishReason: 'length' }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /output_length/,
    );
  });

  test('returns undefined without calling generateText when there are no events to summarize', async () => {
    let called = false;
    const generateText: AiSdkGenerateTextLike = async () => {
      called = true;
      return { text: 'should not reach' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const result = await summarize(inputWith([]));

    expect(result).toBe(undefined);
    expect(called).toBe(false);
  });

  test('rolling summary sends the prior summary plus only newly folded events', async () => {
    const seen: unknown[] = [];
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        seen.push(options.messages);
        return { text: 'rolled' };
      },
    });
    const old = ev({
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'ALREADY_SUMMARIZED_RAW' },
    });
    const newer = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'NEWLY_EVICTED_RAW' },
    });
    const previousCheckpoint = buildHistoryCompactCheckpoint({
      sessionId: 'sess-1',
      coveredRuntimeEvents: [old],
      summary: 'PRIOR_SUMMARY',
    });
    const input = inputWith([old, newer]);

    const result = await summarize({
      ...input,
      previousCheckpoint,
      newlyFoldedRuntimeEvents: [newer],
      inputBudget: { maxEstimatedTokens: 10_000, charsPerToken: 1 },
    });

    expect(result).toBe('rolled');
    const serialized = JSON.stringify(seen[0]);
    expect(serialized).toContain('PRIOR_SUMMARY');
    expect(serialized).toContain('NEWLY_EVICTED_RAW');
    expect(serialized.includes('ALREADY_SUMMARIZED_RAW')).toBe(false);
  });

  test('recompresses the full source when the previous checkpoint is provider-native', async () => {
    let seen: unknown;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        seen = options.messages;
        return { text: 'portable summary' };
      },
    });
    const old = ev({
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'OLD_PROVIDER_ONLY_FACT' },
    });
    const newer = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'NEW_PORTABLE_FACT' },
    });
    const previousCheckpoint = buildHistoryCompactCheckpoint({
      sessionId: 'sess-1',
      coveredRuntimeEvents: [old],
      providerState: {
        kind: 'openai_codex_remote_v2',
        connectionSlug: 'codex-subscription',
        modelId: 'gpt-5.3-codex',
        itemId: 'cmp_123',
        encryptedContent: 'opaque-state',
      },
    });

    await summarize({
      ...inputWith([old, newer]),
      previousCheckpoint,
      newlyFoldedRuntimeEvents: [newer],
    });

    const serialized = JSON.stringify(seen);
    expect(serialized).toContain('OLD_PROVIDER_ONLY_FACT');
    expect(serialized).toContain('NEW_PORTABLE_FACT');
    expect(serialized.includes('opaque-state')).toBe(false);
  });
});
