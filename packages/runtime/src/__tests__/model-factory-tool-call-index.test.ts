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

interface StreamedToolCall {
  index: number;
  id: string;
  path: string;
}

/** A gateway turn that emits one text block, then the given tool calls. */
function streamingRelay(toolCalls: StreamedToolCall[]): typeof globalThis.fetch {
  const payloads = [
    chunk({ role: 'assistant', content: 'Reading it.' }),
    ...toolCalls.flatMap(({ index, id, path }) => [
      chunk({
        tool_calls: [
          { index, id, type: 'function', function: { name: 'read_file', arguments: '' } },
        ],
      }),
      chunk({ tool_calls: [{ index, function: { arguments: `{"path":"${path}"}` } }] }),
    ]),
    chunk({}, 'tool_calls'),
  ];
  const body = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`;
  return async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collectStream(toolCalls: StreamedToolCall[]): Promise<LanguageModelV4StreamPart[]> {
  const model = getAIModel({
    connection,
    apiKey: 'test-key',
    modelId: 'claude-opus-4-8',
    fetch: streamingRelay(toolCalls),
  });
  const { stream } = await model.doStream({ prompt, tools });
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function toolCallsOf(parts: LanguageModelV4StreamPart[]) {
  return parts
    .filter((part) => part.type === 'tool-call')
    .map(({ toolCallId, toolName, input }) => ({ toolCallId, toolName, input }));
}

function assertStreamSucceeded(parts: LanguageModelV4StreamPart[]): void {
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
}

describe('getAIModel: OpenAI-compatible streamed tool_calls index', () => {
  for (const index of [0, 1, 7]) {
    test(`emits the tool call when the gateway labels it index ${index}`, async () => {
      const parts = await collectStream([{ index, id: 'call_1', path: 'a.txt' }]);

      assert.deepEqual(toolCallsOf(parts), [
        { toolCallId: 'call_1', toolName: 'read_file', input: '{"path":"a.txt"}' },
      ]);
      assertStreamSucceeded(parts);
    });
  }

  // Holes must not merge, drop, or reorder calls either. A fix that appends every
  // new index instead of honouring it would still pass the single-call cases above.
  test('keeps two tool calls distinct and ordered when index 0 is a hole', async () => {
    const parts = await collectStream([
      { index: 1, id: 'call_1', path: 'a.txt' },
      { index: 2, id: 'call_2', path: 'b.txt' },
    ]);

    assert.deepEqual(toolCallsOf(parts), [
      { toolCallId: 'call_1', toolName: 'read_file', input: '{"path":"a.txt"}' },
      { toolCallId: 'call_2', toolName: 'read_file', input: '{"path":"b.txt"}' },
    ]);
    assertStreamSucceeded(parts);
  });
});
