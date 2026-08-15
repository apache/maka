import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { stableJsonLength } from '../context-budget-helpers.js';
import { HistoryCompactSummarizerError } from '../history-compact-error.js';
import type { ModelMessage } from '../model-protocol.js';
import {
  extractOpenAiCodexCompactionState,
  fitOpenAiCodexCompactionMessages,
} from '../openai-codex-history-compactor.js';

describe('OpenAI Codex history compaction input', () => {
  test('bounds oversized tool evidence without breaking the call/result pair', () => {
    const oversizedOutput = 'raw-tool-output-'.repeat(1_024);
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'shell',
            input: { command: 'inspect' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'shell',
            output: { type: 'text', value: oversizedOutput },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'The inspection completed.' }] },
    ];

    const bounded = fitOpenAiCodexCompactionMessages(messages, {
      maxInputEstimatedTokens: 600,
      charsPerToken: 1,
    });

    assert.ok(stableJsonLength(bounded) <= 600);
    assert.equal(JSON.stringify(bounded).includes(oversizedOutput), false);
    assert.deepEqual(
      bounded.flatMap((message) =>
        typeof message.content === 'string'
          ? []
          : message.content
              .filter((part) => part.type === 'tool-call' || part.type === 'tool-result')
              .map((part) => ({ type: part.type, toolCallId: part.toolCallId })),
      ),
      [
        { type: 'tool-call', toolCallId: 'call-1' },
        { type: 'tool-result', toolCallId: 'call-1' },
      ],
    );
  });

  test('fails before dispatch when non-tool history cannot fit', () => {
    assert.throws(
      () =>
        fitOpenAiCodexCompactionMessages(
          [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(1_000) }] }],
          { maxInputEstimatedTokens: 10, charsPerToken: 1 },
        ),
      (error) =>
        error instanceof HistoryCompactSummarizerError && error.reason === 'input_too_large',
    );
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
