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

import type { ModelCallCommit } from '@maka/core/agent-run';
/**
 * Tests for buildLlmHistorySummarizer — the AI-SDK-backed LLM summary that
 * replaces the deterministic excerpt draft when wiring injects it.
 *
 * Run: `npm run build && npm --workspace @maka/runtime run test:dist`
 */
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
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
import { SUMMARY_FORMAT_TEMPLATE } from '../history-compact-summary-validation.js';

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

// Minimal summary that passes #3029's checkpoint validation (required
// sections, no truncation markers).
const VALID_SUMMARY = [
  '## Goal',
  'X',
  '',
  '## Progress',
  '- done',
  '',
  '## Next Steps',
  '1. continue',
  '',
  '## Critical Context',
  '- (none)',
].join('\n');

function inputWith(events: RuntimeEvent[], abortSignal?: AbortSignal): HistoryCompactSummaryInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    source: { foldedRuntimeEvents: events },
    ...(abortSignal ? { abortSignal } : {}),
  };
}

describe('buildLlmHistorySummarizer', () => {
  test('inherits the session provider options and applies the default output cap', async () => {
    let seen: Parameters<AiSdkGenerateTextLike>[0] | undefined;
    const providerOptions = { openaiCompatible: { reasoningEffort: 'high' } };
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      providerOptions,
      generateText: async (options) => {
        seen = options;
        return { text: VALID_SUMMARY };
      },
    });

    await summarize({
      ...inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    });

    assert.strictEqual(seen?.providerOptions, providerOptions);
    assert.strictEqual(seen?.maxOutputTokens, 8_000);
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
            content: [{ type: 'text', text: VALID_SUMMARY }],
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
        persistArtifact: async () => ({ artifactId: 'artifact-1' }),
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

  test('attributes a malformed completion and its repair to separate logical steps', async () => {
    const recorded: ModelCallAttempt[] = [];
    let providerCalls = 0;
    let id = 0;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () =>
        new MockLanguageModelV4({
          doGenerate: async () => {
            providerCalls += 1;
            return {
              content: [
                {
                  type: 'text' as const,
                  text: providerCalls === 1 ? 'free-form incomplete summary' : VALID_SUMMARY,
                },
              ],
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: {
                inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 3, text: 3, reasoning: 0 },
              },
              warnings: [],
            };
          },
        }),
    });

    await summarize({
      ...inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      providerRequestTracker: new ProviderRequestTracker({
        traceId: 'trace-id',
        turnId: 'turn-1',
        now: () => 100 + id,
        newId: () => `request-${++id}`,
        persistArtifact: async () => ({ artifactId: `artifact-${id}` }),
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

    assert.equal(providerCalls, 2);
    assert.deepEqual(
      recorded.map((attempt) => attempt.step),
      [0, 1],
    );
    assert.deepEqual(
      recorded.map((attempt) => attempt.attempt),
      [0, 0],
    );
    assert.notEqual(recorded[0]?.logicalCallId, recorded[1]?.logicalCallId);
  });

  test('produces schema-valid tool-result messages (toolName + wrapped output) and does not fall back', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: VALID_SUMMARY };
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
    assert.strictEqual(result, VALID_SUMMARY);

    const messages = seen[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string; toolName?: string; output?: unknown }>;
    }>;
    const toolPart = messages.find((m) => m.role === 'tool')!.content[0]!;
    assert.strictEqual(toolPart.type, 'tool-result');
    // toolName must be present in AI SDK tool-result content.
    assert.strictEqual(toolPart.toolName, 'read');
    // output must be the {type, value} wrapper, not the raw result object
    assert.deepStrictEqual(toolPart.output, { type: 'json', value: { name: 'maka' } });
  });

  test('groups parallel tool calls into one assistant message for strict providers', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: VALID_SUMMARY };
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
    // The request always ends on the summary instruction; the folded span is
    // everything before it.
    assert.deepEqual(shape.slice(-5), [
      'assistant:tool-call+tool-call',
      'tool:tool-result',
      'tool:tool-result',
      'assistant:text',
      'user:text',
    ]);
  });

  test('keeps a step open across interleaved results until every call is settled', async () => {
    // The production-legal ordering from the primary replay materializer's
    // fixture: call A, call B, result A, call C, result B, result C. All
    // three calls must share one assistant message with the results after it.
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: VALID_SUMMARY };
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
      'user:text',
    ]);
    assert.deepEqual(
      messages[1]!.content.map((part) => part.toolCallId),
      ['fc1', 'fc2', 'fc3'],
    );
    assert.deepEqual(
      messages.slice(2, -1).map((m) => m.content[0]!.toolCallId),
      ['fc1', 'fc2', 'fc3'],
    );
  });

  test('ends every summary request with a user instruction the model can answer', async () => {
    // A chat-template model handed a conversation that ends on its own turn
    // emits end-of-sequence and nothing else (observed on Ollama qwen2.5:
    // finish `stop`, one output token, empty text). The request therefore
    // closes with an instruction, on the first attempt and on the repair.
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return seen.length === 1
        ? { text: 'not a summary', finishReason: 'stop' }
        : { text: VALID_SUMMARY, finishReason: 'stop' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => ({}), generateText });
    await summarize(
      inputWith([
        ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'question' } }),
        ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'answer' } }),
      ]),
    );
    assert.equal(seen.length, 2);
    for (const call of seen) {
      const last = call.messages.at(-1) as {
        role: string;
        content: Array<{ type: string; text?: string }>;
      };
      assert.equal(last.role, 'user');
      assert.match(last.content[0]!.text ?? '', /write the structured summary/i);
    }
  });

  test('does not merge distinct settled steps into one assistant message', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: VALID_SUMMARY };
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
      'user:text',
    ]);
  });

  test('stamped step ids decide membership over settledness', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: VALID_SUMMARY };
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
      'user:text',
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

  test('shortens the prompt once when the first summary hits the output limit', async () => {
    const instructions: string[] = [];
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        instructions.push(options.instructions);
        return {
          text: VALID_SUMMARY,
          finishReason: instructions.length === 1 ? 'length' : 'stop',
        };
      },
    });

    assert.equal(
      await summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      VALID_SUMMARY,
    );
    assert.equal(instructions.length, 2);
    assert.match(instructions[1] ?? '', /cut off at the output limit/);
  });

  test('rejects the incident fragment: a free-form summary without the mandated sections', async () => {
    // The #3029 incident: 742 folded events accepted a 138-token free-form
    // fragment as their checkpoint. Section-less prose must fail open.
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({
        text: '确认服务端语义后，决定：先只在文本路径上加入预算判断。现在看 desktop 的 retry 循环结尾：',
        finishReason: 'stop',
      }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('repairs one malformed completion with a single stricter retry', async () => {
    const instructions: string[] = [];
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        instructions.push(options.instructions);
        return {
          text: instructions.length === 1 ? 'free-form incomplete summary' : VALID_SUMMARY,
          finishReason: 'stop',
        };
      },
    });

    const result = await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );

    assert.equal(result, VALID_SUMMARY);
    assert.equal(instructions.length, 2);
    assert.match(instructions[1] ?? '', /malformed_summary_missing_section/);
  });

  test('bounds a persistently malformed completion at two provider calls', async () => {
    let calls = 0;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => {
        calls += 1;
        return { text: 'free-form incomplete summary', finishReason: 'stop' };
      },
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      (error) =>
        error instanceof HistoryCompactSummarizerError &&
        error.reason === 'malformed_summary_missing_section',
    );
    assert.equal(calls, 2);
  });

  test('preserves the initial malformed defect when the repair request fails', async () => {
    let calls = 0;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => {
        calls += 1;
        if (calls === 1) return { text: 'free-form incomplete summary', finishReason: 'stop' };
        throw new Error('model down during repair');
      },
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      (error) =>
        error instanceof HistoryCompactSummarizerError &&
        error.reason === 'malformed_summary_missing_section' &&
        error.cause instanceof HistoryCompactSummarizerError &&
        error.cause.reason === 'provider_error' &&
        error.cause.cause instanceof Error &&
        error.cause.cause.message === 'model down during repair',
    );
    assert.equal(calls, 2);
  });

  test('a context-length rejection of the repair request stays the input_too_large signal', async () => {
    // The initial request fit; the stricter repair prompt is longer and the
    // provider rejected it. That rejection must reach the planner as
    // `input_too_large` so it retreats, not be filed under the initial defect.
    let calls = 0;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => {
        calls += 1;
        if (calls === 1) return { text: 'free-form incomplete summary', finishReason: 'stop' };
        throw new Error(
          "This model's maximum context length is 1000 tokens. However, your messages exceed the context window.",
        );
      },
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      (error) =>
        error instanceof HistoryCompactSummarizerError && error.reason === 'input_too_large',
    );
    assert.equal(calls, 2);
  });

  test('preserves cancellation when a malformed-summary repair is aborted', async () => {
    let calls = 0;
    const abortError = Object.assign(new Error('stopped during repair'), { name: 'AbortError' });
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => {
        calls += 1;
        if (calls === 1) return { text: 'free-form incomplete summary', finishReason: 'stop' };
        throw abortError;
      },
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      (error) => error === abortError,
    );
    assert.equal(calls, 2);
  });

  test('preserves the initial malformed defect when the repair is empty', async () => {
    let calls = 0;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => {
        calls += 1;
        return {
          text: calls === 1 ? 'free-form incomplete summary' : '',
          finishReason: 'stop',
        };
      },
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      (error) =>
        error instanceof HistoryCompactSummarizerError &&
        error.reason === 'malformed_summary_missing_section',
    );
    assert.equal(calls, 2);
  });

  test('a deeper heading level cannot stand in for a mandated section', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({
        text: VALID_SUMMARY.replaceAll('## ', '### '),
      }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('headings quoted inside a fenced code block are not summary structure', async () => {
    // A weak model can echo the requested template as a fenced example
    // instead of producing the checkpoint; that must not replace history.
    const fencedTemplate = [
      '```markdown',
      '## Goal',
      'template goal',
      '## Progress',
      'template progress',
      '## Next Steps',
      'template next',
      '```',
    ].join('\n');
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: fencedTemplate }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('requires the Critical Context section the incident lost', async () => {
    // Files, commands, and errors live in Critical Context — exactly the
    // information whose loss made the #3029 continuation confabulate. The
    // template offers an explicit "(none)" escape hatch, so a summary simply
    // omitting the section is a defect, not a style choice.
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({
        text: '## Goal\nX\n\n## Progress\n- done\n\n## Next Steps\n1. continue',
      }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('an unfenced verbatim echo of the prompt template is not a checkpoint', async () => {
    // A degraded model can parrot the mandated format back with all the
    // placeholder lines intact; every heading is present and every section
    // "has content", but none of it is information. Template lines never
    // count as section content.
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: SUMMARY_FORMAT_TEMPLATE.join('\n') }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('a four-backtick fence is not closed by a three-backtick line', async () => {
    // Markdown closes a fence only with a run at least as long as the
    // opener. A template echo wrapped in ````markdown with a ``` line inside
    // used to be misread as closed, letting the fenced headings count as
    // structure.
    const fourFenceEcho = [
      '````markdown',
      '## Goal',
      'echoed goal',
      '```',
      '## Progress',
      'echoed progress',
      '## Next Steps',
      'echoed next',
      '## Critical Context',
      'echoed context',
      '````',
    ].join('\n');
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: fourFenceEcho }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('a trailing shorter run leaves a wide fence open: truncation', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: `${VALID_SUMMARY}\n\n\`\`\`\`\ncode\n\`\`\`` }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_truncated/,
    );
  });

  test('a fence marker with trailing text is content, not a closer', async () => {
    // CommonMark: an opener may carry an info string, a closer may not.
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: `${VALID_SUMMARY}\n\n\`\`\`\ncode\n\`\`\` done` }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_truncated/,
    );
  });

  test('nested bare fence markers are not section content', async () => {
    // A section whose only lines are fence delimiters carries no information;
    // the inner shorter run must not satisfy the non-empty requirement.
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({
        text: '## Goal\n````\n```\n````\n\n## Progress\n- done\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)',
      }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('a four-space-indented marker run is indented code, not a fence closer', async () => {
    // Markdown allows a fence delimiter at most three leading spaces; four or
    // more is indented code, so it must not close the open fence.
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: `${VALID_SUMMARY}\n\n\`\`\`\ncode\n    \`\`\`` }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_truncated/,
    );
  });

  test('a fence closer indented up to three spaces still closes', async () => {
    const threeSpaceCloser = `${VALID_SUMMARY}\n\n\`\`\`\ncode\n   \`\`\`\nafter`;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: threeSpaceCloser }),
    });

    const result = await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );
    assert.strictEqual(result, threeSpaceCloser);
  });

  test('a longer same-family run still closes a narrower fence', async () => {
    const closedByLonger = `${VALID_SUMMARY}\n\n\`\`\`\ncode\n\`\`\`\`\nafter`;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: closedByLonger }),
    });

    const result = await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );
    assert.strictEqual(result, closedByLonger);
  });

  test('indented and bare heading markers are headings, not section content', async () => {
    // CommonMark ATX headings tolerate up to three leading spaces and allow
    // the marker run to end the line; a skeleton padded with such pseudo-body
    // lines carries no information and must not earn the sectioned marker.
    const skeleton = [
      '## Goal',
      ' ### Done',
      '',
      '## Progress',
      '  ###',
      '',
      '## Next Steps',
      ' ##',
      '',
      '## Critical Context',
      '   #### notes',
    ].join('\n');
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: skeleton }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('a required heading indented up to three spaces still matches its section', async () => {
    const indented = VALID_SUMMARY.replace('## Progress', ' ## Progress');
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: indented }),
    });

    const result = await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );
    assert.strictEqual(result, indented);
  });

  test('rejects a heading-only skeleton with no section content', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: '## Goal\n## Progress\n## Next Steps' }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('horizontal rules between headings are separators, not section content', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: '## Goal\n---\n## Progress\n***\n## Next Steps\n- - -' }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('content under a non-required section cannot satisfy a required one', async () => {
    // "## Key Decisions" opens its own section; its bullets must not stand in
    // for an empty "## Progress" above it.
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({
        text: '## Goal\nX\n\n## Progress\n\n## Key Decisions\n- decided something\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)',
      }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('accepts a well-formed summary with CRLF line endings', async () => {
    const crlf = VALID_SUMMARY.replaceAll('\n', '\r\n');
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: crlf }),
    });

    const result = await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );
    assert.strictEqual(result, crlf);
  });

  test('CRLF horizontal rules are still separators, not section content', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({
        text: '## Goal\r\n---\r\n## Progress\r\n***\r\n## Next Steps\r\n- - -\r\n## Critical Context\r\n---',
      }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('rejects the mandated sections when they appear out of order', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({
        text: '## Progress\n- done\n\n## Goal\nX\n\n## Next Steps\n1. continue',
      }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_missing_section/,
    );
  });

  test('requires each mandated section heading to match the whole line', async () => {
    for (const suffix of [' continued', ':', ' - details']) {
      const summarize = buildLlmHistorySummarizer({
        resolveModel: () => 'fake-model',
        generateText: async () => ({
          text: VALID_SUMMARY.replace('## Goal\n', `## Goal${suffix}\n`),
        }),
      });

      await assert.rejects(
        summarize(
          inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
        ),
        /malformed_summary_missing_section/,
      );
    }
  });

  test('rejects a structured summary that ends mid-sentence on a trailing colon', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: `${VALID_SUMMARY}\n- 然后：` }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_truncated/,
    );
  });

  test('rejects a structured summary ending in an ASCII ellipsis', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: `${VALID_SUMMARY}\n- continuing...` }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_truncated/,
    );
  });

  test('rejects a structured summary with an unclosed code fence', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: `${VALID_SUMMARY}\n\n\`\`\`ts\nconst x =` }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /malformed_summary_truncated/,
    );
  });

  test('a verbatim inline fence marker in a preserved error message is not truncation', async () => {
    const withInlineFence = `${VALID_SUMMARY}\n- markdown lint: unexpected \`\`\` at line 12`;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: withInlineFence }),
    });

    const result = await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );
    assert.strictEqual(result, withInlineFence);
  });

  test('rejects a paragraph-sized summary for a large folded span when usage says it is too small', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      // Structurally complete, but far below the floor for a large fold.
      generateText: async () => ({
        text: VALID_SUMMARY,
        usage: { inputTokens: 20_000, outputTokens: 50 },
      }),
    });

    await assert.rejects(
      summarize(
        inputWith([
          ev({
            role: 'user',
            author: 'user',
            content: { kind: 'text', text: `big ${'x'.repeat(60_000)}` },
          }),
        ]),
      ),
      /malformed_summary_too_small_for_fold/,
    );
  });

  test("a provider's context-length rejection is the fold's input_too_large signal", async () => {
    // The summarizer's provider is the one judge of whether the fold fits its
    // window. A fake provider that rejects above N characters must surface as
    // `input_too_large`, the reason the planner retreats on, not as a generic
    // provider error that fails the fold open.
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      if (JSON.stringify(opts.messages).length > 2_000) {
        throw new Error(
          "This model's maximum context length is 1000 tokens. However, your messages exceed the context window.",
        );
      }
      return { text: VALID_SUMMARY, finishReason: 'stop' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });
    await assert.rejects(
      summarize(
        inputWith([
          ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'x'.repeat(5_000) } }),
        ]),
      ),
      (error: unknown) =>
        error instanceof HistoryCompactSummarizerError && error.reason === 'input_too_large',
    );
    assert.equal(
      await summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'small' } })]),
      ),
      VALID_SUMMARY,
    );
  });

  test('the usage floor judges an initial fold and stands down on a roll-forward', async () => {
    // On an initial fold the summarizer's input IS the covered span, so a
    // 50-token summary of a 20,000-token span is a fragment. On a roll-forward
    // the input is the previous summary plus the increment, not the span, so
    // the same numbers say nothing about the whole and the floor must not
    // reject the fold on them.
    const old = ev({
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: `big ${'x'.repeat(60_000)}` },
    });
    const newer = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'one small turn' },
    });
    const previousCheckpoint = buildHistoryCompactCheckpoint({
      sessionId: 'sess-1',
      coveredRuntimeEvents: [old],
      summary: 'PRIOR_SUMMARY',
      summaryFormat: 'legacy_freeform',
    });
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({
        text: VALID_SUMMARY,
        usage: { inputTokens: 20_000, outputTokens: 50 },
      }),
    });

    await assert.rejects(
      summarize(inputWith([old, newer])),
      /malformed_summary_too_small_for_fold/,
    );
    assert.equal(
      await summarize({
        ...inputWith([old, newer]),
        previousCheckpoint,
        newlyFoldedRuntimeEvents: [newer],
      }),
      VALID_SUMMARY,
    );
  });

  test('a summary without provider usage is not rejected by the size floor', async () => {
    const skeleton = (progress: string) =>
      `## Goal\nX\n\n## Progress\n- ${progress}\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)`;
    const exactFloor = skeleton('p'.repeat(799 - skeleton('').length));
    assert.equal(exactFloor.length, 799);
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: exactFloor }),
    });

    const result = await summarize(
      inputWith([
        ev({
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: `big ${'x'.repeat(60_000)}` },
        }),
      ]),
    );
    assert.strictEqual(result, exactFloor);
  });

  test('accepts a proportionate structured summary for a large folded span', async () => {
    const longSummary = [
      '## Goal',
      'X',
      '',
      '## Progress',
      `- ${'done '.repeat(200)}`,
      '',
      '## Next Steps',
      '1. continue',
      '',
      '## Critical Context',
      '- (none)',
    ].join('\n');
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: longSummary }),
    });

    const result = await summarize(
      inputWith([
        ev({
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: `big ${'x'.repeat(60_000)}` },
        }),
      ]),
    );
    assert.strictEqual(result, longSummary);
  });

  test('returns undefined without calling generateText when there are no events to summarize', async () => {
    let called = false;
    const generateText: AiSdkGenerateTextLike = async () => {
      called = true;
      return { text: 'should not reach' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const result = await summarize(inputWith([]));

    assert.strictEqual(result, undefined);
    assert.strictEqual(called, false);
  });

  test('rolling summary sends the prior summary plus only newly folded events', async () => {
    const seen: unknown[] = [];
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        seen.push(options.messages);
        return { text: VALID_SUMMARY };
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
      summaryFormat: 'legacy_freeform',
    });
    const input = inputWith([old, newer]);

    const result = await summarize({
      ...input,
      previousCheckpoint,
      newlyFoldedRuntimeEvents: [newer],
    });

    assert.strictEqual(result, VALID_SUMMARY);
    const serialized = JSON.stringify(seen[0]);
    assert.ok(serialized.includes('PRIOR_SUMMARY'));
    assert.ok(serialized.includes('NEWLY_EVICTED_RAW'));
    assert.strictEqual(serialized.includes('ALREADY_SUMMARIZED_RAW'), false);
  });

  test('recompresses the full source when the previous checkpoint is provider-native', async () => {
    let seen: unknown;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        seen = options.messages;
        return { text: VALID_SUMMARY };
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
        connectionId: 'connection-codex',
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
    assert.ok(serialized.includes('OLD_PROVIDER_ONLY_FACT'));
    assert.ok(serialized.includes('NEW_PORTABLE_FACT'));
    assert.strictEqual(serialized.includes('opaque-state'), false);
  });
});
