import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  extractOpenAiCodexCompactionState,
  fitOpenAiCodexCompactionMessages,
} from '../openai-codex-history-compactor.js';

test('preserves the provider-specific input-fitting export', () => {
  assert.deepEqual(
    fitOpenAiCodexCompactionMessages(
      [{ role: 'user', content: [{ type: 'text', text: 'bounded history' }] }],
      { maxInputEstimatedTokens: 1_000, charsPerToken: 1 },
    ),
    [{ role: 'user', content: [{ type: 'text', text: 'bounded history' }] }],
  );
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
        connectionSlug: 'codex-subscription',
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
