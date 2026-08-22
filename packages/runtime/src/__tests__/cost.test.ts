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

import { computeCost } from '../telemetry/cost.js';
import { recordLlmCall } from '../telemetry/record-llm-call.js';
import { recordToolInvocation } from '../telemetry/record-tool-invocation.js';
import type { PersistedLlmCallRecord, PersistedToolInvocationRecord } from '../telemetry/types.js';

describe('computeCost', () => {
  test('charges full input price only for cache-miss input', () => {
    const cost = computeCost(
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheHitInputTokens: 30,
        cacheMissInputTokens: 60,
        cacheWriteInputTokens: 10,
      },
      {
        modelKey: 'deepseek:deepseek-chat',
        inputUsdPer1M: 1,
        outputUsdPer1M: 2,
        cacheReadUsdPer1M: 0.25,
        cacheWriteUsdPer1M: 1.5,
      },
    );

    assert.equal(cost.inputCost, 0.00006);
    assert.equal(cost.cacheReadCost, 0.0000075);
    assert.ok(Math.abs(cost.cacheWriteCost - 0.000015) < 1e-12);
    assert.equal(cost.outputCost, 0.0001);
    assert.ok(Math.abs(cost.totalCost - 0.0001825) < 1e-12);
  });

  test('derives cache miss from total input when explicit miss is absent', () => {
    const cost = computeCost(
      {
        inputTokens: 100,
        outputTokens: 0,
        cachedInputTokens: 40,
        cacheWriteInputTokens: 10,
      },
      {
        modelKey: 'deepseek:deepseek-chat',
        inputUsdPer1M: 1,
        outputUsdPer1M: 2,
        cacheReadUsdPer1M: 0.25,
        cacheWriteUsdPer1M: 1.5,
      },
    );

    assert.equal(cost.inputCost, 0.00005);
    assert.equal(cost.cacheReadCost, 0.00001);
    assert.ok(Math.abs(cost.cacheWriteCost - 0.000015) < 1e-12);
    assert.ok(Math.abs(cost.totalCost - 0.000075) < 1e-12);
  });

  test('treats all input as fresh when no cache data exists', () => {
    const cost = computeCost(
      {
        inputTokens: 100,
        outputTokens: 0,
      },
      {
        modelKey: 'deepseek:deepseek-chat',
        inputUsdPer1M: 1,
        outputUsdPer1M: 2,
        cacheReadUsdPer1M: 0.25,
      },
    );

    assert.equal(cost.inputCost, 0.0001);
    assert.equal(cost.cacheReadCost, 0);
    assert.equal(cost.totalCost, 0.0001);
  });
});

describe('recordLlmCall', () => {
  test('preserves a runtime-provided cost fact instead of recomputing it', async () => {
    const inserted: PersistedLlmCallRecord[] = [];

    await recordLlmCall(
      {
        repo: {
          insertLlmCall: async (record) => {
            inserted.push(record);
          },
        },
        lookupPricing: () => {
          throw new Error('lookup should not run when costUsd is already present');
        },
      },
      {
        turnId: 'turn-1',
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.123,
        latencyMs: 7,
        status: 'success',
        startedAt: 100,
      },
    );

    assert.equal(inserted[0]?.costUsd, 0.123);
  });

  test('settles only after publication and preserves main token fields and diagnostics', async () => {
    let publish!: () => void;
    const publication = new Promise<void>((resolve) => {
      publish = resolve;
    });
    const inserted: PersistedLlmCallRecord[] = [];
    let settled = false;

    const recording = recordLlmCall(
      {
        repo: {
          insertLlmCall: (record) => {
            inserted.push(record);
            return publication;
          },
        },
        lookupPricing: () => null,
      },
      {
        sessionId: 'session-1',
        turnId: 'turn-1',
        callKind: 'semantic_compact',
        callId: 'compact-1',
        connectionSlug: 'connection-1',
        providerId: 'anthropic',
        modelId: 'claude',
        inputTokens: 20,
        outputTokens: 8,
        cacheHitInputTokens: 7,
        cachedInputTokens: 6,
        cacheWriteInputTokens: 3,
        reasoningTokens: 2,
        totalTokens: 30,
        rawFinishReason: 'stop',
        rawUsage: {
          prompt_tokens: 20,
          completion_tokens: 8,
          total_tokens: 28,
          prompt_cache_hit_tokens: 7,
          prompt_cache_miss_tokens: 10,
          prompt_tokens_details: { cached_tokens: 7 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
        latencyMs: 5,
        status: 'success',
        startedAt: 100,
        systemPromptHash: 'system-hash',
        prefixHash: 'prefix-hash',
        prefixChangeReason: 'first_turn',
        requestShapeHash: 'request-hash',
        requestShapeChangeReason: 'tool_schema_changed',
        toolSchemaChangeReason: 'tool_source_enabled',
        promptSegments: [{ kind: 'system_prompt', chars: 40, estimatedTokens: 10 }],
        contextBudget: {
          enabled: true,
          estimatedTokensBefore: 30,
          estimatedTokensAfter: 20,
          keptTurns: 2,
          droppedTurns: 1,
          keptEvents: 4,
          droppedEvents: 2,
        },
      },
    );
    const settlement = recording.then(() => {
      settled = true;
    });
    await Promise.resolve();

    assert.equal(settled, false);
    assert.equal(inserted[0]?.id, 'usage_compact-1');
    assert.equal(inserted[0]?.cacheHitInputTokens, 7);
    assert.equal(inserted[0]?.cachedInputTokens, 7);
    assert.equal(inserted[0]?.cacheMissInputTokens, 10);
    assert.equal(inserted[0]?.cacheMissInputSource, 'derived');
    assert.equal(inserted[0]?.cacheWriteInputTokens, 3);
    assert.equal(inserted[0]?.reasoningTokens, 2);
    assert.equal(inserted[0]?.totalTokens, 30);
    assert.deepEqual(inserted[0]?.rawUsage, {
      prompt_tokens: 20,
      completion_tokens: 8,
      total_tokens: 28,
      prompt_cache_hit_tokens: 7,
      prompt_cache_miss_tokens: 10,
      prompt_tokens_details: { cached_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 2 },
    });
    assert.deepEqual(inserted[0]?.promptSegments, [
      { kind: 'system_prompt', chars: 40, estimatedTokens: 10 },
    ]);
    assert.equal(inserted[0]?.contextBudget?.droppedEvents, 2);
    assert.equal(inserted[0]?.toolSchemaChangeReason, 'tool_source_enabled');

    publish();
    await settlement;
    assert.equal(settled, true);
  });

  test('contains writer failures at the best-effort telemetry boundary', async () => {
    const messages: string[] = [];
    const originalConsoleError = console.error;
    console.error = (message?: unknown) => {
      messages.push(String(message));
    };
    try {
      await assert.doesNotReject(() =>
        recordLlmCall(
          {
            repo: {
              insertLlmCall: async () => {
                throw new Error('publication failed');
              },
            },
            lookupPricing: () => null,
          },
          {
            providerId: 'openai',
            modelId: 'gpt-5',
            inputTokens: 1,
            outputTokens: 1,
            latencyMs: 1,
            status: 'success',
            startedAt: 1,
          },
        ),
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /^\[telemetry\] recordLlmCall failed:/);
  });
});

describe('recordToolInvocation', () => {
  test('settles only after normalized record publication completes', async () => {
    let publish!: () => void;
    const publication = new Promise<void>((resolve) => {
      publish = resolve;
    });
    const inserted: PersistedToolInvocationRecord[] = [];
    let settled = false;

    const recording = recordToolInvocation(
      {
        repo: {
          insertToolInvocation: (record) => {
            inserted.push(record);
            return publication;
          },
        },
      },
      {
        toolCallId: 'call-1',
        toolName: 'Bash',
        durationMs: 5,
        status: 'success',
        resultSummary: { kind: 'shell', status: 'completed', itemCount: 1 },
        startedAt: 100,
      },
    );
    const settlement = recording.then(() => {
      settled = true;
    });
    await Promise.resolve();

    assert.equal(settled, false);
    assert.equal(inserted[0]?.id, 'tool_call-1');
    assert.equal(inserted[0]?.ts, 105);
    assert.equal(inserted[0]?.bytesIn, 0);
    assert.equal(inserted[0]?.bytesOut, 0);
    assert.deepEqual(inserted[0]?.resultSummary, {
      kind: 'shell',
      status: 'completed',
      itemCount: 1,
    });

    publish();
    await settlement;
    assert.equal(settled, true);
  });

  test('contains writer failures at the best-effort telemetry boundary', async () => {
    const messages: string[] = [];
    const originalConsoleError = console.error;
    console.error = (message?: unknown) => {
      messages.push(String(message));
    };
    try {
      await assert.doesNotReject(() =>
        recordToolInvocation(
          {
            repo: {
              insertToolInvocation: async () => {
                throw new Error('publication failed');
              },
            },
          },
          {
            toolCallId: 'call-failed',
            toolName: 'Read',
            durationMs: 2,
            status: 'error',
            startedAt: 100,
          },
        ),
      );
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /^\[telemetry\] recordToolInvocation failed:/);
  });
});
