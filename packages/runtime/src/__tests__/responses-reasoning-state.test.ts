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
    { version: 2, profile: 'alibaba-token-plan-cn', itemId: 'item' },
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
  assert.deepEqual(
    decodePlaintextResponsesReasoningState({
      makaResponses: {
        version: 2,
        profile: 'another-provider',
        itemId: 'item',
      },
    }),
    { kind: 'malformed', profile: 'another-provider' },
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
