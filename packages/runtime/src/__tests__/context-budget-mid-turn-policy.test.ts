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
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  buildDefaultContextBudgetPolicy,
  resolveContextBudgetCapacity,
} from '../context-budget-policy.js';

describe('mid-turn history compact policy env plumbing', () => {
  test('defaults on with no compaction env at all (the runtime, not the surface, owns it)', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), { env: {} });
    assert.equal(policy?.historyCompact?.enabled, true);
    assert.deepEqual(policy?.historyCompact?.midTurn, { enabled: true, reserveTokens: 16_384 });
  });

  test('honors explicit reserve and tail-event overrides', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: {
        MAKA_CONTEXT_HISTORY_COMPACT_RESERVE_TOKENS: '8000',
        MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN_TAIL_EVENTS: '2',
      },
    });
    assert.deepEqual(policy?.historyCompact?.midTurn, {
      enabled: true,
      reserveTokens: 8_000,
      reserveTailEvents: 2,
    });
  });

  test('MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN=off is the escape hatch even with history compact on', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: {
        MAKA_CONTEXT_HISTORY_COMPACT: 'on',
        MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN: 'off',
      },
    });
    assert.equal(policy?.historyCompact?.enabled, true);
    assert.equal(policy?.historyCompact?.midTurn, undefined);
  });

  test('an explicit MAKA_CONTEXT_HISTORY_COMPACT=off disables history compaction and midTurn with it', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: { MAKA_CONTEXT_HISTORY_COMPACT: 'off' },
    });
    assert.equal(policy?.historyCompact, undefined);
  });
});

describe('window-bounded reserve derivation (issue #882 PR 3 review P2)', () => {
  test('caps the derived reserve on a small-window model instead of degrading to a 1-token budget', () => {
    // gpt-4 has an 8192-token window. A flat 16384 reserve used to derive
    // maxHistoryEstimatedTokens = max(1, 8192 - 16384) = 1, and a mid_turn
    // high water clamped to 1 token — every multi-step turn ran the
    // summarizer for a checkpoint that could never pass the replay gate.
    // The default reserve must be bounded by the KNOWN window: a quarter of
    // the window, capped at the classic 16384.
    const policy = buildDefaultContextBudgetPolicy(gpt4Connection(), { env: {}, modelId: 'gpt-4' });
    assert.equal(policy?.maxHistoryEstimatedTokens, 8192 - 2048);
    assert.deepEqual(policy?.historyCompact?.midTurn, { enabled: true, reserveTokens: 2048 });
  });

  test('uses the official Agent Plan default-model window instead of the unknown-model fallback', () => {
    const policy = buildDefaultContextBudgetPolicy(agentPlanConnection(), { env: {} });
    assert.equal(policy?.maxHistoryEstimatedTokens, 256_000 - 16_384);
    assert.deepEqual(policy?.historyCompact?.midTurn, { enabled: true, reserveTokens: 16_384 });
  });

  test('keeps the classic 16384 reserve when the window is unknown (metadata-less model)', () => {
    const policy = buildDefaultContextBudgetPolicy(
      {
        ...gpt4Connection(),
        defaultModel: 'custom-model',
        models: [{ id: 'custom-model' }],
      } as LlmConnection,
      { env: {}, modelId: 'custom-model' },
    );
    // No window: the flat 32_000 fallback budget and the classic reserve.
    assert.equal(policy?.maxHistoryEstimatedTokens, 32_000);
    assert.deepEqual(policy?.historyCompact?.midTurn, { enabled: true, reserveTokens: 16_384 });
    assert.deepEqual(
      resolveContextBudgetCapacity(
        {
          ...gpt4Connection(),
          defaultModel: 'custom-model',
          models: [{ id: 'custom-model' }],
        } as LlmConnection,
        'custom-model',
        policy,
      ),
      { tokens: 48_384, source: 'policy_fallback' },
    );
  });

  test('respects an explicit reserve override verbatim even on a small window', () => {
    const policy = buildDefaultContextBudgetPolicy(gpt4Connection(), {
      env: { MAKA_CONTEXT_HISTORY_COMPACT_RESERVE_TOKENS: '6000' },
      modelId: 'gpt-4',
    });
    assert.equal(policy?.maxHistoryEstimatedTokens, 8192 - 6000);
    assert.deepEqual(policy?.historyCompact?.midTurn, { enabled: true, reserveTokens: 6000 });
  });
});

describe('tool-result prune policy env plumbing', () => {
  test('provides bounded active and stale defaults', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), { env: {} });
    assert.deepEqual(policy?.activeToolResultPrune, {
      enabled: true,
      maxCurrentResultEstimatedTokens: 2_048,
      minSupersededResultEstimatedTokens: 256,
      minStepNumber: 1,
    });
    assert.deepEqual(policy?.staleToolResultPrune, {
      enabled: true,
      maxResultEstimatedTokens: 2_048,
      minRecentTurnsFull: 2,
    });
  });

  test('applies explicit bounds and stale recent-turn precedence', () => {
    const policy = buildDefaultContextBudgetPolicy(connection(), {
      env: {
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '4096',
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_SUPERSEDED_TOKENS: '384',
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: '3',
        MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS: '8192',
        MAKA_CONTEXT_MIN_RECENT_TURNS: '4',
        MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS: '5',
      },
    });
    assert.equal(policy?.activeToolResultPrune?.maxCurrentResultEstimatedTokens, 4_096);
    assert.equal(policy?.activeToolResultPrune?.minSupersededResultEstimatedTokens, 384);
    assert.equal(policy?.activeToolResultPrune?.minStepNumber, 3);
    assert.equal(policy?.staleToolResultPrune?.maxResultEstimatedTokens, 8_192);
    assert.equal(policy?.staleToolResultPrune?.minRecentTurnsFull, 5);
  });

  test('honors explicit disablement and rejects malformed booleans', () => {
    const disabled = buildDefaultContextBudgetPolicy(connection(), {
      env: {
        MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'false',
        MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'off',
      },
    });
    assert.equal(disabled?.activeToolResultPrune, undefined);
    assert.equal(disabled?.staleToolResultPrune, undefined);
    assert.equal(
      buildDefaultContextBudgetPolicy(connection(), { env: { MAKA_CONTEXT_BUDGET: 'off' } }),
      undefined,
    );
    assert.throws(
      () =>
        buildDefaultContextBudgetPolicy(connection(), {
          env: { MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'maybe' },
        }),
      /MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE must be a boolean/,
    );
  });
});

function gpt4Connection(): LlmConnection {
  return {
    slug: 'openai-main',
    name: 'OpenAI',
    providerType: 'openai',
    defaultModel: 'gpt-4',
    models: [{ id: 'gpt-4' }],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  } as LlmConnection;
}

function connection(): LlmConnection {
  return {
    slug: 'anthropic-main',
    name: 'Anthropic',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('declared relay context window', () => {
  test('a user declaration outranks the relay /models report and metadata', () => {
    const relay: LlmConnection = {
      slug: 'my-relay',
      name: 'My Relay',
      providerType: 'openai-compatible',
      baseUrl: 'https://relay.example/v1',
      defaultModel: 'reasoner-32k',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      models: [{ id: 'reasoner-32k', contextWindow: 8_192 }],
      relayModelProfiles: { 'reasoner-32k': { contextWindow: 131_072 } },
    };
    const policy = buildDefaultContextBudgetPolicy(relay, { env: {}, modelId: 'reasoner-32k' });
    // Declared 131_072 wins: reserve 131_072/4 caps at 16_384. The fetched
    // 8_192 row would have yielded 8_192 − 2_048, and no declaration at all
    // would have fallen to the 32_000 unknown-model default.
    assert.equal(policy?.maxHistoryEstimatedTokens, 131_072 - 16_384);
    // Clearing the declaration falls back to the fetched row's window.
    const undeclared: LlmConnection = { ...relay, relayModelProfiles: undefined };
    const fallback = buildDefaultContextBudgetPolicy(undeclared, {
      env: {},
      modelId: 'reasoner-32k',
    });
    assert.equal(fallback?.maxHistoryEstimatedTokens, 8_192 - 2_048);
  });

  test('a declared context window holds on any provider', () => {
    // A context window is a fact about the model, and the reason to declare
    // one — Maka has no other way to learn it — is not confined to relays: it
    // holds for a model newer than the bundled snapshot, and for every model
    // on a provider with no model-list endpoint (#1584). What stays relay-only
    // is the wire-shaped fields, `thinkingLevels` and `serviceTier`, which the
    // catalog codec refuses to persist on another provider.
    const other: LlmConnection = {
      slug: 'other',
      name: 'Other',
      providerType: 'openai',
      defaultModel: 'reasoner-32k',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      models: [{ id: 'reasoner-32k', contextWindow: 8_192 }],
      relayModelProfiles: { 'reasoner-32k': { contextWindow: 131_072 } },
    };
    const policy = buildDefaultContextBudgetPolicy(other, { env: {}, modelId: 'reasoner-32k' });
    assert.equal(policy?.maxHistoryEstimatedTokens, 131_072 - 16_384);
    // Absent stays absent: an undeclared model still reads the stored row.
    const undeclared: LlmConnection = { ...other, relayModelProfiles: undefined };
    assert.equal(
      buildDefaultContextBudgetPolicy(undeclared, { env: {}, modelId: 'reasoner-32k' })
        ?.maxHistoryEstimatedTokens,
      8_192 - 2_048,
    );
  });
});

function agentPlanConnection(): LlmConnection {
  return {
    slug: 'volcengine-agent-plan',
    name: 'Volcengine Agent Plan',
    providerType: 'volcengine-agent-plan',
    defaultModel: 'ark-code-latest',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
