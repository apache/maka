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
    'summary',
    'alibaba-token-plan-cn',
  );
  assert.deepEqual(options, {
    makaResponses: {
      version: 1,
      profile: 'alibaba-token-plan-cn',
      itemId: 'reasoning-item-1',
      carrier: 'summary',
    },
  });
  assert.deepEqual(decodePlaintextResponsesReasoningState(options), {
    kind: 'valid',
    state: {
      version: 1,
      profile: 'alibaba-token-plan-cn',
      itemId: 'reasoning-item-1',
      carrier: 'summary',
    },
  });
  assert.equal(responsesReasoningItemId(options), 'reasoning-item-1');
});

test('rejects malformed, widened, and unsafe plaintext Responses state', () => {
  for (const makaResponses of [
    { version: 2, profile: 'alibaba-token-plan-cn', itemId: 'item', carrier: 'summary' },
    { version: 1, profile: '', itemId: 'item', carrier: 'summary' },
    { version: 1, profile: 'bad\nprofile', itemId: 'item', carrier: 'summary' },
    { version: 1, profile: 'alibaba-token-plan-cn', itemId: '', carrier: 'summary' },
    { version: 1, profile: 'alibaba-token-plan-cn', itemId: 'bad\nitem', carrier: 'summary' },
    { version: 1, profile: 'alibaba-token-plan-cn', itemId: 'item', carrier: 'unknown' },
    {
      version: 1,
      profile: 'alibaba-token-plan-cn',
      itemId: 'item',
      carrier: 'summary',
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
        carrier: 'summary',
      },
    }),
    { kind: 'malformed', profile: 'another-provider' },
  );
});

test('reconstructs provider-native summary and content carriers', () => {
  const summary = {
    version: 1,
    profile: 'alibaba-token-plan-cn',
    itemId: 'summary-item',
    carrier: 'summary',
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
        reasoningSummary: [{ type: 'summary_text', text: 'reasoning summary' }],
        reasoningContent: null,
      },
    },
  );

  const content = {
    version: 1,
    profile: 'deepseek',
    itemId: 'content-item',
    carrier: 'content',
  } as const;
  assert.deepEqual(
    replayPlaintextResponsesProviderOptions({
      providerOptionsKey: 'deepseek',
      state: content,
      text: 'plaintext reasoning',
    }),
    {
      deepseek: {
        itemId: 'content-item',
        reasoningSummary: [],
        reasoningContent: [{ type: 'reasoning_text', text: 'plaintext reasoning' }],
      },
    },
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
