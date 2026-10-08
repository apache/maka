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

  test('falls back when native state is unusable or its projection cannot fit', () => {
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
      true,
    );
  });

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

function compactionModel(): MockLanguageModelV4 {
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
        chunks,
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    },
  });
}
