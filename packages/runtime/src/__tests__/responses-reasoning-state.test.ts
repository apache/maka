import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  plaintextResponsesReasoningProviderOptions,
  readPlaintextResponsesReasoningState,
  replayPlaintextResponsesProviderOptions,
  responsesReasoningItemId,
} from '../responses-reasoning-state.js';

test('round-trips one bounded versioned plaintext Responses item identity', () => {
  const options = plaintextResponsesReasoningProviderOptions('reasoning-item-1', 'summary');
  assert.deepEqual(options, {
    makaResponses: { version: 1, itemId: 'reasoning-item-1', carrier: 'summary' },
  });
  assert.deepEqual(readPlaintextResponsesReasoningState(options), {
    version: 1,
    itemId: 'reasoning-item-1',
    carrier: 'summary',
  });
  assert.equal(responsesReasoningItemId(options), 'reasoning-item-1');
});

test('rejects malformed, widened, and unsafe plaintext Responses state', () => {
  for (const makaResponses of [
    { version: 2, itemId: 'item', carrier: 'summary' },
    { version: 1, itemId: '', carrier: 'summary' },
    { version: 1, itemId: 'bad\nitem', carrier: 'summary' },
    { version: 1, itemId: 'item', carrier: 'unknown' },
    { version: 1, itemId: 'item', carrier: 'summary', raw: 'provider-body' },
  ]) {
    assert.equal(readPlaintextResponsesReasoningState({ makaResponses }), undefined);
  }
});

test('reconstructs provider-native summary and content carriers', () => {
  const summary = { version: 1, itemId: 'summary-item', carrier: 'summary' } as const;
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

  const content = { version: 1, itemId: 'content-item', carrier: 'content' } as const;
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
