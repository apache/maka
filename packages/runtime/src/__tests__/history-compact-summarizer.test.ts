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
  test('inherits the session provider options without imposing a compaction-only output cap', async () => {
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
    expect(result).toBe(VALID_SUMMARY);

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
    ]);
  });

  test('bounds the oldest oversized tool result before dispatch while preserving newer context', async () => {
    let seen: Parameters<AiSdkGenerateTextLike>[0] | undefined;
    const generateText: AiSdkGenerateTextLike = async (options) => {
      seen = options;
      // Proportionate to the large folded span so the size floor passes.
      return { text: VALID_SUMMARY.replace('- done', `- ${'done '.repeat(200)}`) };
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
    expect(result).toBe(threeSpaceCloser);
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
    expect(result).toBe(closedByLonger);
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
    expect(result).toBe(indented);
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
    expect(result).toBe(crlf);
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
    expect(result).toBe(withInlineFence);
  });

  test('rejects a paragraph-sized summary for a large folded span', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      // Structurally complete, but far below the floor for a large fold.
      generateText: async () => ({ text: VALID_SUMMARY }),
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

  test('the size floor covers the full replaced span, not just the newly folded increment', async () => {
    // Steady-state roll-forward: the checkpoint replaces everything it covers,
    // so a small increment must not let a fragment replace a large span.
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
      generateText: async () => ({ text: VALID_SUMMARY }),
    });

    await assert.rejects(
      summarize({
        ...inputWith([old, newer]),
        previousCheckpoint,
        newlyFoldedRuntimeEvents: [newer],
      }),
      /malformed_summary_too_small_for_fold/,
    );
  });

  test('a summary at exactly the floor is accepted under ceil-based token estimates', async () => {
    // 799 chars at 4 chars/token is ceil(799/4) = 200 estimated tokens —
    // exactly the documented floor, so it must pass, not be rejected by a
    // raw-character comparison.
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
    expect(result).toBe(exactFloor);
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
    expect(result).toBe(longSummary);
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
      inputBudget: { maxEstimatedTokens: 10_000, charsPerToken: 1 },
    });

    expect(result).toBe(VALID_SUMMARY);
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
