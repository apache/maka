import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import type { RuntimeExecutionConnection } from '@maka/core';
import { getAIModel } from '@maka/runtime';

/**
 * Regression guard for #1967: OpenAI-compatible gateways are free to label streamed
 * `tool_calls[].index` with any stable number — the field identifies which tool call a
 * delta belongs to, it is not an array position. Anthropic→OpenAI translators commonly
 * reuse the Anthropic content-block index, so the first tool call arrives as index 1
 * once a text block consumed index 0. This must stream through like any other tool call.
 */

const connection: RuntimeExecutionConnection = {
  slug: 'relay',
  providerType: 'openai-compatible',
  baseUrl: 'https://relay.invalid/v1',
  defaultModel: 'claude-opus-4-8',
};

const prompt: LanguageModelV4CallOptions['prompt'] = [
  { role: 'user', content: [{ type: 'text', text: 'read a.txt' }] },
];

const tools: LanguageModelV4CallOptions['tools'] = [
  {
    type: 'function',
    name: 'read_file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

function chunk(delta: unknown, finishReason: string | null = null): unknown {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'claude-opus-4-8',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** A gateway turn that emits one text block, then one tool call at `toolCallIndex`. */
function streamingRelay(toolCallIndex: number): typeof globalThis.fetch {
  const payloads = [
    chunk({ role: 'assistant', content: 'Reading it.' }),
    chunk({
      tool_calls: [
        {
          index: toolCallIndex,
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '' },
        },
      ],
    }),
    chunk({ tool_calls: [{ index: toolCallIndex, function: { arguments: '{"path":"a.txt"}' } }] }),
    chunk({}, 'tool_calls'),
  ];
  const body = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`;
  return async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collectStream(toolCallIndex: number): Promise<LanguageModelV4StreamPart[]> {
  const model = getAIModel({
    connection,
    apiKey: 'test-key',
    modelId: 'claude-opus-4-8',
    fetch: streamingRelay(toolCallIndex),
  });
  const { stream } = await model.doStream({ prompt, tools });
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function toolCallOf(parts: LanguageModelV4StreamPart[]) {
  return parts.find((part) => part.type === 'tool-call');
}

describe('getAIModel: OpenAI-compatible streamed tool_calls index', () => {
  for (const toolCallIndex of [0, 1, 7]) {
    test(`emits the tool call when the gateway labels it index ${toolCallIndex}`, async () => {
      const parts = await collectStream(toolCallIndex);

      assert.deepEqual(
        toolCallOf(parts),
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'read_file',
          input: '{"path":"a.txt"}',
        },
        'the tool call must survive whatever index the gateway assigned',
      );
      assert.equal(
        parts.at(-1)?.type,
        'finish',
        'the stream must close cleanly instead of failing the whole turn',
      );
      assert.deepEqual(
        parts.filter((part) => part.type === 'error'),
        [],
        'a non-zero tool call index is not a stream error',
      );
    });
  }
});
