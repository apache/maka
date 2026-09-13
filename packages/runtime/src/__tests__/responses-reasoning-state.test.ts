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
import { test } from 'node:test';
import {
  decodePlaintextResponsesReasoningState,
  plaintextResponsesReasoningProviderOptions,
  replayPlaintextResponsesProviderOptions,
  responsesReasoningItemId,
} from '../responses-reasoning-state.js';

test('round-trips one bounded versioned plaintext Responses item identity', () => {
  const options = plaintextResponsesReasoningProviderOptions(
    'reasoning-item-1',
    'alibaba-token-plan-cn',
    ['reasoning summary'],
  );
  assert.deepEqual(options, {
    makaResponses: {
      version: 1,
      profile: 'alibaba-token-plan-cn',
      itemId: 'reasoning-item-1',
      summaryPartLengths: [17],
    },
  });
  assert.deepEqual(decodePlaintextResponsesReasoningState(options), {
    kind: 'valid',
    state: {
      version: 1,
      profile: 'alibaba-token-plan-cn',
      itemId: 'reasoning-item-1',
      summaryPartLengths: [17],
    },
  });
  assert.equal(responsesReasoningItemId(options), 'reasoning-item-1');
});

test('rejects malformed, widened, and unsafe plaintext Responses state', () => {
  for (const makaResponses of [
    { version: '2', profile: 'alibaba-token-plan-cn', itemId: 'item' },
    { version: 1, profile: '', itemId: 'item' },
    { version: 1, profile: 'bad\nprofile', itemId: 'item' },
    { version: 1, profile: 'alibaba-token-plan-cn', itemId: '' },
    { version: 1, profile: 'alibaba-token-plan-cn', itemId: 'bad\nitem' },
    {
      version: 1,
      profile: 'alibaba-token-plan-cn',
      itemId: 'item',
      summaryPartLengths: [4],
      raw: 'provider-body',
    },
  ]) {
    assert.equal(decodePlaintextResponsesReasoningState({ makaResponses }).kind, 'malformed');
  }
  assert.deepEqual(decodePlaintextResponsesReasoningState(undefined), { kind: 'missing' });
});

test('degrades a well-formed state version that this Runtime cannot replay', () => {
  assert.deepEqual(
    decodePlaintextResponsesReasoningState({
      makaResponses: {
        version: 2,
        profile: 'alibaba-token-plan-cn',
        itemId: 'item',
        summaryPartLengths: [4],
      },
    }),
    { kind: 'unsupported-version', version: 2 },
  );
});

test('reconstructs provider-native summary parts', () => {
  const summary = {
    version: 1,
    profile: 'alibaba-token-plan-cn',
    itemId: 'summary-item',
    summaryPartLengths: [10, 7],
  } as const;
  assert.deepEqual(
    replayPlaintextResponsesProviderOptions({
      providerOptionsKey: 'alibaba-token-plan-cn',
      state: summary,
      text: 'reasoning summary',
    }),
    {
      'alibaba-token-plan-cn': {
        itemId: 'summary-item',
        reasoningSummary: [
          { type: 'summary_text', text: 'reasoning ' },
          { type: 'summary_text', text: 'summary' },
        ],
        reasoningContent: null,
      },
    },
  );
});

test('rejects summary boundaries that disagree with canonical text', () => {
  const state = {
    version: 1,
    profile: 'alibaba-token-plan-cn',
    itemId: 'summary-item',
    summaryPartLengths: [8],
  } as const;
  assert.throws(
    () =>
      replayPlaintextResponsesProviderOptions({
        providerOptionsKey: 'alibaba-token-plan-cn',
        state: { ...state, summaryPartLengths: [3] },
        text: 'expected',
      }),
    /summary boundaries do not match text/,
  );
});

test('keeps encrypted OpenAI item identity readable for shared step grouping', () => {
  assert.equal(
    responsesReasoningItemId({
      openai: { itemId: 'openai-item', reasoningEncryptedContent: 'encrypted' },
    }),
    'openai-item',
  );
});
