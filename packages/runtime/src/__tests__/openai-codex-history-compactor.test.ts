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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import {
  buildOpenAiCodexHistoryCompactor,
  extractOpenAiCodexCompactionState,
  shouldFallbackFromOpenAiCodexHistoryCompaction,
  withOpenAiCodexHistoryCompactionFallback,
} from '../openai-codex-history-compactor.js';
import { HistoryCompactSummarizerError } from '../history-compact-error.js';
import type { HistoryCompactSummaryInput } from '../ai-sdk-compaction-contract.js';
import {
  buildHistoryCompactCheckpoint,
  renderHistoryCompactCheckpoint,
  isProviderHistoryCompactCheckpoint,
} from '../history-compact-checkpoint.js';
import { planHistoryCompaction } from '../history-compaction.js';
import { buildLlmHistorySummarizer } from '../history-compact-summarizer.js';
import { testInvocationRecord } from './invocation-fixture.js';
import { sectionedSummary } from './history-compact-test-fixtures.js';

describe('OpenAI Codex compaction fallback', () => {
  const input: HistoryCompactSummaryInput = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    source: { foldedRuntimeEvents: [] },
  };

  test('falls back after a non-retryable native protocol rejection', async () => {
    const providerError = Object.assign(new Error('private provider message'), {
      statusCode: 400,
      data: { error: { code: 'missing_required_parameter' } },
    });
    const nativeError = new HistoryCompactSummarizerError('provider_error', {
      cause: providerError,
    });
    let fallbackCalls = 0;
    const summarize = withOpenAiCodexHistoryCompactionFallback(
      async () => {
        throw nativeError;
      },
      async () => {
        fallbackCalls += 1;
        return 'portable checkpoint';
      },
    );

    assert.equal(await summarize(input), 'portable checkpoint');
    assert.equal(fallbackCalls, 1);
  });

  test('falls back on unusable native state but leaves capacity errors to the planner', () => {
    assert.equal(
      shouldFallbackFromOpenAiCodexHistoryCompaction(
        new HistoryCompactSummarizerError('invalid_provider_state'),
      ),
      true,
    );
    assert.equal(
      shouldFallbackFromOpenAiCodexHistoryCompaction(
        new HistoryCompactSummarizerError('input_too_large'),
      ),
      false,
    );
  });

  for (const alwaysOverflow of [false, true]) {
    test(`native capacity ${alwaysOverflow ? 'failure terminates' : 'retry preserves the uncovered tail'} without text fallback`, async () => {
      const events = [
        runtimeEvent({
          id: 'old-user',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'OLD_USER '.repeat(100) },
        }),
        assistantTextEvent('old-model', 'old-step', 'OLD_MODEL '.repeat(100)),
        runtimeEvent({
          id: 'recent-user',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'RECENT_USER' },
        }),
        assistantTextEvent('recent-model', 'recent-step', 'UNCOVERED_RECENT_REPLY'),
      ];
      let calls = 0;
      let fallbackCalls = 0;
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          if (++calls === 1 || alwaysOverflow)
            throw Object.assign(new Error('prompt is too long: context length exceeded'), {
              name: 'AI_APICallError',
              statusCode: 400,
            });
          return await compactionModel().doStream(options);
        },
      });
      const summarize = withOpenAiCodexHistoryCompactionFallback(
        buildOpenAiCodexHistoryCompactor({
          resolveModel: () => model,
          connectionId: 'codex-subscription',
          modelId: 'gpt-5.3-codex',
        }),
        async () => {
          fallbackCalls += 1;
          return sectionedSummary('TEXT_FALLBACK');
        },
      );
      const invocation = testInvocationRecord({
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-previous',
        outcome: 'completed',
        opening: {
          route: {
            provenance: 'runtime',
            backendKind: 'ai-sdk',
            llmConnectionId: 'codex-subscription',
            llmConnectionSlug: 'codex-subscription',
            modelId: 'gpt-5.3-codex',
          },
        },
      });
      const plan = await planHistoryCompaction({
        sessionId: 'session-1',
        phase: 'standalone',
        orderedEvents: events,
        invocations: [invocation],
        acceptedRoute: { connectionId: 'codex-subscription', modelId: 'gpt-5.3-codex' },
        summarize: ({ coveredRuntimeEvents }) =>
          summarize({
            sessionId: 'session-1',
            turnId: 'turn-compact',
            source: { foldedRuntimeEvents: [...coveredRuntimeEvents], invocations: [invocation] },
          }),
      });
      assert.equal(model.doStreamCalls.length, 2);
      assert.equal(fallbackCalls, 0);
      assert.match(JSON.stringify(model.doStreamCalls[0]?.prompt), /UNCOVERED_RECENT_REPLY/);
      assert.doesNotMatch(JSON.stringify(model.doStreamCalls[1]?.prompt), /UNCOVERED_RECENT_REPLY/);
      if (alwaysOverflow) {
        assert.deepEqual(plan, {
          decision: 'fail_open',
          reason: 'summarizer_failed',
          diagnosticReason: 'input_too_large',
        });
      } else {
        assert.equal(plan.decision, 'compacted');
        if (plan.decision !== 'compacted') assert.fail('expected native checkpoint');
        assert.equal(isProviderHistoryCompactCheckpoint(plan.checkpoint), true);
        assert.deepEqual(
          plan.tailRuntimeEvents.map((event) => event.id),
          ['recent-model'],
        );
        assert.match(JSON.stringify(plan.replacementEvents), /UNCOVERED_RECENT_REPLY/);
        assert.doesNotMatch(JSON.stringify(plan.checkpoint), /TEXT_FALLBACK/);
      }
    });
  }

  test('does not fall back on cancellation, rate limits, or provider availability', () => {
    const rateLimit = new HistoryCompactSummarizerError('provider_error', {
      cause: Object.assign(new Error('private provider message'), { statusCode: 429 }),
    });
    const unavailable = new HistoryCompactSummarizerError('provider_error', {
      cause: Object.assign(new Error('private provider message'), { statusCode: 503 }),
    });
    const aborted = new HistoryCompactSummarizerError('provider_error', {
      cause: new DOMException('cancelled', 'AbortError'),
    });

    assert.equal(shouldFallbackFromOpenAiCodexHistoryCompaction(rateLimit), false);
    assert.equal(shouldFallbackFromOpenAiCodexHistoryCompaction(unavailable), false);
    assert.equal(shouldFallbackFromOpenAiCodexHistoryCompaction(aborted), false);
  });
});

describe('OpenAI Codex compaction output', () => {
  const compactPart = (itemId: unknown, encryptedContent: unknown) => ({
    type: 'custom',
    kind: 'openai.compaction',
    providerMetadata: { openai: { itemId, encryptedContent } },
  });

  test('accepts exactly one complete compaction item', () => {
    assert.deepEqual(
      extractOpenAiCodexCompactionState(
        [compactPart('item-1', 'encrypted-1')],
        'codex-subscription',
        'gpt-5.3-codex',
      ),
      {
        kind: 'openai_codex_remote_v2',
        connectionId: 'codex-subscription',
        modelId: 'gpt-5.3-codex',
        itemId: 'item-1',
        encryptedContent: 'encrypted-1',
      },
    );
  });

  test('rejects missing, ambiguous, and incomplete compaction items', () => {
    assert.equal(extractOpenAiCodexCompactionState([], 'connection', 'model'), undefined);
    assert.equal(
      extractOpenAiCodexCompactionState(
        [compactPart('item-1', 'encrypted-1'), compactPart('item-2', 'encrypted-2')],
        'connection',
        'model',
      ),
      undefined,
    );
    assert.equal(
      extractOpenAiCodexCompactionState([compactPart('item-1', '')], 'connection', 'model'),
      undefined,
    );
  });
});

describe('OpenAI Codex compaction input', () => {
  test('preserves the verbatim head anchor of a text mid-turn checkpoint (#6154)', async () => {
    const anchor = runtimeEvent({
      id: 'anchor',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'EXACT_USER_DIRECTIVE' },
    });
    const old = assistantTextEvent('old', 'old-step', 'ALREADY_FOLDED');
    const tail = assistantTextEvent('tail', 'tail-step', 'NEW_TAIL');
    const previous = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [anchor, old],
      summary: sectionedSummary('PORTABLE_SUMMARY'),
      phase: 'mid_turn',
      headAnchor: { runtimeEventId: anchor.id, turnId: anchor.turnId },
    });
    const model = compactionModel();
    await buildOpenAiCodexHistoryCompactor({
      resolveModel: () => model,
      connectionId: 'codex-subscription',
      modelId: 'gpt-5.3-codex',
    })({
      sessionId: 'session-1',
      turnId: 'turn-current',
      source: { foldedRuntimeEvents: [anchor, old, tail] },
      previousCheckpoint: previous,
      newlyFoldedRuntimeEvents: [tail],
    });

    const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
    assert.match(prompt, /PORTABLE_SUMMARY.*EXACT_USER_DIRECTIVE.*NEW_TAIL/);
    assert.doesNotMatch(prompt, /ALREADY_FOLDED/);
  });

  for (const nativeState of [true, false]) {
    test(`continues a rolled text checkpoint with ${nativeState ? 'native state' : 'text fallback'} (#6154)`, async () => {
      const old = assistantTextEvent('old', 'old-step', 'RAW_ALREADY_SUMMARIZED '.repeat(1000));
      const newer = assistantTextEvent('newer', 'newer-step', 'RAW_FOLDED_AGAIN');
      const tail = assistantTextEvent('tail', 'tail-step', 'NEW_TAIL');
      const first = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [old],
        summary: sectionedSummary('FIRST_SUMMARY'),
      });
      const previous = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [old, newer],
        summary: sectionedSummary('LATEST_SUMMARY'),
        previousCheckpointId: first.checkpointId,
      });
      const model = compactionModel(nativeState);
      const fallbackInputs: unknown[] = [];
      const native = buildOpenAiCodexHistoryCompactor({
        resolveModel: () => model,
        connectionId: 'codex-subscription',
        modelId: 'gpt-5.3-codex',
      });
      const fallback = buildLlmHistorySummarizer({
        resolveModel: () => 'unused',
        generateText: async (options) => {
          fallbackInputs.push(options.messages);
          return { text: sectionedSummary('FALLBACK_SUMMARY') };
        },
      });
      const summarize = withOpenAiCodexHistoryCompactionFallback(native, fallback);
      const plan = await planHistoryCompaction({
        sessionId: 'session-1',
        phase: 'standalone',
        orderedEvents: [old, newer, tail],
        previousCheckpoint: previous,
        summarize: ({ coveredRuntimeEvents, newlyFoldedRuntimeEvents, previousCheckpoint }) =>
          summarize({
            sessionId: 'session-1',
            turnId: 'turn-current',
            source: { foldedRuntimeEvents: [...coveredRuntimeEvents] },
            newlyFoldedRuntimeEvents: [...newlyFoldedRuntimeEvents],
            previousCheckpoint,
          }),
      });

      const prompt = model.doStreamCalls[0]?.prompt;
      assert.equal(prompt?.[0]?.role, 'user');
      const firstPart = prompt?.[0]?.content[0];
      assert.equal(
        firstPart?.type === 'text' ? firstPart.text : undefined,
        renderHistoryCompactCheckpoint(previous),
      );
      assert.match(JSON.stringify(prompt), /NEW_TAIL/);
      assert.doesNotMatch(
        JSON.stringify(prompt),
        /RAW_ALREADY_SUMMARIZED|RAW_FOLDED_AGAIN|FIRST_SUMMARY/,
      );
      if (!nativeState) {
        assert.equal(fallbackInputs.length, 1);
        assert.match(JSON.stringify(fallbackInputs), /LATEST_SUMMARY/);
        assert.match(JSON.stringify(fallbackInputs), /NEW_TAIL/);
        assert.doesNotMatch(
          JSON.stringify(fallbackInputs),
          /RAW_ALREADY_SUMMARIZED|RAW_FOLDED_AGAIN/,
        );
      }
      assert.equal(plan.decision, 'compacted');
      if (plan.decision !== 'compacted') assert.fail('expected compaction');
      assert.equal(plan.checkpoint.version, nativeState ? 3 : 2);
      assert.equal(plan.checkpoint.previousCheckpointId, previous.checkpointId);
      assert.equal(plan.checkpoint.coverage.eventCount, 3);
    });
  }

  test('keeps an interrupted late tool step after the intervening assistant step', async () => {
    const model = compactionModel();
    const summarize = buildOpenAiCodexHistoryCompactor({
      resolveModel: () => model,
      connectionId: 'codex-subscription',
      modelId: 'gpt-5.3-codex',
    });

    await summarize({
      sessionId: 'session-1',
      turnId: 'turn-current',
      source: {
        foldedRuntimeEvents: [
          assistantTextEvent('text-a', 'shared-step', 'Text A'),
          assistantTextEvent('text-b', 'intervening-step', 'Text B'),
          toolCallEvent(),
          toolResultEvent(),
        ],
      },
    });

    assert.deepEqual(
      model.doStreamCalls[0]?.prompt.map((message) => ({
        role: message.role,
        parts: Array.isArray(message.content)
          ? message.content.map((part) => (part.type === 'text' ? `text:${part.text}` : part.type))
          : [`text:${message.content}`],
      })),
      [
        { role: 'assistant', parts: ['text:Text A'] },
        { role: 'assistant', parts: ['text:Text B'] },
        { role: 'assistant', parts: ['tool-call'] },
        { role: 'tool', parts: ['tool-result'] },
      ],
    );
  });
});

function assistantTextEvent(id: string, stepId: string, text: string): RuntimeEvent {
  return runtimeEvent({
    id,
    role: 'model',
    author: 'agent',
    refs: { providerEventId: stepId },
    content: { kind: 'text', text },
  });
}

function toolCallEvent(): RuntimeEvent {
  return runtimeEvent({
    id: 'tool-call',
    role: 'model',
    author: 'agent',
    refs: { stepId: 'shared-step' },
    content: {
      kind: 'function_call',
      id: 'read-1',
      name: 'Read',
      args: { path: 'notes.md' },
    },
  });
}

function toolResultEvent(): RuntimeEvent {
  return runtimeEvent({
    id: 'tool-result',
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'read-1',
      name: 'Read',
      result: { kind: 'text', text: 'contents' },
      isError: false,
    },
  });
}

function runtimeEvent(
  input: Pick<RuntimeEvent, 'id' | 'role' | 'author'> & Pick<RuntimeEvent, 'content' | 'refs'>,
): RuntimeEvent {
  return {
    id: input.id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-previous',
    ts: 1,
    partial: false,
    role: input.role,
    author: input.author,
    content: input.content,
    refs: input.refs,
  };
}

function compactionModel(nativeState = true): MockLanguageModelV4 {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    {
      type: 'custom',
      kind: 'openai.compaction',
      providerMetadata: { openai: { itemId: 'cmp-1', encryptedContent: 'encrypted-1' } },
    },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 0, reasoning: 0 },
      },
    },
  ];
  return new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: nativeState ? chunks : chunks.filter((part) => part.type !== 'custom'),
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  });
}
