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
  resolveDeclaredContextWindow,
  resolveSelectedModelContextWindow,
} from '../context-budget-policy.js';

test('context policy is independent of process environment overrides', () => {
  const overrides = {
    MAKA_CONTEXT_BUDGET: 'off',
    MAKA_CONTEXT_HISTORY_COMPACT: 'off',
    MAKA_CONTEXT_HISTORY_COMPACT_HIGH_WATER_NAME: 'custom-high-water',
    MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN: 'off',
    MAKA_CONTEXT_HISTORY_COMPACT_MID_TURN_TAIL_EVENTS: '99',
    MAKA_CONTEXT_HISTORY_COMPACT_RESERVE_TOKENS: '1',
    MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE: 'off',
    MAKA_CONTEXT_STALE_TOOL_RESULT_MAX_TOKENS: '1',
    MAKA_CONTEXT_STALE_TOOL_RESULT_MIN_RECENT_TURNS: '99',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE: 'off',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS: '1',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER: '99',
    MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_SUPERSEDED_TOKENS: '1',
  } as const;
  const previous = Object.fromEntries(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of Object.keys(overrides)) delete process.env[name];
    const baseline = buildDefaultContextBudgetPolicy();
    Object.assign(process.env, overrides);
    assert.deepEqual(buildDefaultContextBudgetPolicy(), baseline);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

describe('mid-turn history compact policy', () => {
  test('is owned by the runtime default', () => {
    const policy = buildDefaultContextBudgetPolicy();
    assert.equal(policy?.historyCompact?.enabled, true);
    assert.deepEqual(policy?.historyCompact?.midTurn, { enabled: true });
  });
});

describe('tool-result prune policy', () => {
  test('uses bounded runtime defaults', () => {
    const policy = buildDefaultContextBudgetPolicy();
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
    assert.equal(resolveDeclaredContextWindow(relay, 'reasoner-32k'), 131_072);
    assert.deepEqual(buildDefaultContextBudgetPolicy().historyCompact?.midTurn, { enabled: true });
    // Clearing the declaration does not turn the fetched row into a Maka
    // window; it is provider metadata and remains display-only.
    const undeclared: LlmConnection = { ...relay, relayModelProfiles: undefined };
    assert.equal(resolveDeclaredContextWindow(undeclared, 'reasoner-32k'), undefined);
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
    assert.equal(resolveDeclaredContextWindow(other, 'reasoner-32k'), 131_072);
    // Absent stays absent: an undeclared model still has no Maka threshold.
    const undeclared: LlmConnection = { ...other, relayModelProfiles: undefined };
    assert.equal(resolveDeclaredContextWindow(undeclared, 'reasoner-32k'), undefined);
  });
});
