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

    await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );

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
          record: (attempt: ModelCallAttempt) => {
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

  test('an output-length result settles the credential lease exactly once as failure', async () => {
    const settled: string[] = [];
    let released = 0;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: '', finishReason: 'length' }),
      acquireCredential: async () => ({
        apiKey: 'sk-aux',
        settle: async (outcome) => {
          settled.push(outcome);
        },
        release: () => {
          released += 1;
        },
      }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /output_length/,
    );
    // The lease must be settled exactly once (as failure for an unusable
    // output-length response), never success-then-failure.
    assert.deepEqual(settled, ['failure']);
    assert.equal(released, 1);
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
    });

    expect(result).toBe('rolled');
    const serialized = JSON.stringify(seen[0]);
    expect(serialized).toContain('PRIOR_SUMMARY');
    expect(serialized).toContain('NEWLY_EVICTED_RAW');
    expect(serialized.includes('ALREADY_SUMMARIZED_RAW')).toBe(false);
  });

  test('acquires a credential lease, materializes with its key, settles the real outcome and releases', async () => {
    const settled: string[] = [];
    let released = 0;
    let capturedApiKey: string | undefined;
    let modelCalls = 0;
    const generateText: AiSdkGenerateTextLike = async () => {
      modelCalls += 1;
      return { text: '## Goal\nOK' };
    };
    const summarize = buildLlmHistorySummarizer({
      resolveModel: (apiKey) => {
        capturedApiKey = apiKey;
        return 'leased-model';
      },
      generateText,
      acquireCredential: async () => ({
        apiKey: 'sk-aux-leased',
        settle: async (outcome) => {
          settled.push(outcome);
        },
        release: () => {
          released += 1;
        },
      }),
    });

    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'hello' } }),
    ];
    const result = await summarize(inputWith(events));

    expect(result).toBe('## Goal\nOK');
    expect(modelCalls).toBe(1);
    expect(capturedApiKey).toBe('sk-aux-leased');
    expect(settled).toEqual(['success']);
    expect(released).toBe(1);
  });

  test('settles a provider failure as failure and still releases the lease', async () => {
    const settled: string[] = [];
    let released = 0;
    const generateText: AiSdkGenerateTextLike = async () => {
      throw Object.assign(new Error('boom'), { name: 'APICallError' });
    };
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'model',
      generateText,
      acquireCredential: async () => ({
        apiKey: 'sk-aux-leased',
        settle: async (outcome) => {
          settled.push(outcome);
        },
        release: () => {
          released += 1;
        },
      }),
    });
    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /provider_error/,
    );
    expect(settled).toEqual(['failure']);
    expect(released).toBe(1);
  });

  test('an aborted summarization settles as aborted and releases', async () => {
    const settled: string[] = [];
    let released = 0;
    const controller = new AbortController();
    controller.abort();
    const generateText: AiSdkGenerateTextLike = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'model',
      generateText,
      acquireCredential: async () => ({
        apiKey: 'sk-aux-leased',
        settle: async (outcome) => {
          settled.push(outcome);
        },
        release: () => {
          released += 1;
        },
      }),
    });
    await assert.rejects(
      summarize(
        inputWith(
          [ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })],
          controller.signal,
        ),
      ),
      /provider_error/,
    );
    expect(settled).toEqual(['aborted']);
    expect(released).toBe(1);
  });
});
