import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { getAIModel } from '@maka/runtime/model-factory';
import { createOpenAiResponsesPlaintextReasoningTransport } from '../openai-responses-plaintext-reasoning-transport.js';

function conn(providerType: LlmConnection['providerType']): LlmConnection {
  return {
    slug: 'test',
    name: 'test',
    providerType,
    defaultModel: 'm',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

const ITEM_ID = 'd2fb9f45-39e8-4f9e-9cc3-999d591a27ab';
const MESSAGE_ID = 'msg_4a1f0c7b';
const REASONING = 'The user asks if 91 is prime. 91 = 7 x 13, so it is composite.';
const ANSWER = 'No — 91 is 7 x 13.';

/**
 * Recorded from a live `deepseek-v4-flash` streaming call: a reasoning item is
 * opened and closed by the same `output_item` events the SDK already reads,
 * while the text itself arrives on `response.reasoning_text.delta`. That is why
 * the reasoning part used to survive the round trip carrying nothing.
 *
 * The assistant's own reply is part of the fixture because the transport
 * rewrites every DeepSeek response body, not just the reasoning in it: a
 * translator that dropped the message entirely would be the worst failure this
 * code can have, and only an assertion on the reply can see it.
 */
function deepseekReasoningStream(deltas: string[], answer = ANSWER): string {
  const events: Array<Record<string, unknown>> = [
    { type: 'response.created', response: { id: 'r' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: ITEM_ID, status: 'in_progress', content: [], summary: [] },
    },
    ...deltas.map((delta, index) => ({
      type: 'response.reasoning_text.delta',
      content_index: 0,
      delta,
      item_id: ITEM_ID,
      output_index: 0,
      sequence_number: 4 + index,
    })),
    {
      type: 'response.reasoning_text.done',
      content_index: 0,
      item_id: ITEM_ID,
      output_index: 0,
      text: deltas.join(''),
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: ITEM_ID,
        status: 'completed',
        content: [{ type: 'reasoning_text', text: deltas.join('') }],
        summary: [],
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        type: 'message',
        id: MESSAGE_ID,
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.output_text.delta',
      content_index: 0,
      delta: answer,
      item_id: MESSAGE_ID,
      output_index: 1,
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'message',
        id: MESSAGE_ID,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: answer, annotations: [] }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'r',
        object: 'response',
        created_at: 0,
        model: 'deepseek-v4-flash',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

/**
 * Chunks are cut from the encoded bytes, not from the string: slicing the
 * string would hand every chunk a whole character and quietly make multi-byte
 * text untestable, which is the failure this harness exists to expose.
 */
function sseFetch(body: string, chunkSize = Number.MAX_SAFE_INTEGER): typeof globalThis.fetch {
  return (async () => {
    const bytes = new TextEncoder().encode(body);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += chunkSize) {
            controller.enqueue(bytes.slice(at, at + chunkSize));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as unknown as typeof globalThis.fetch;
}

/** A stream cut short by `missingBytes`, as a dropped connection would leave it. */
function truncatingFetch(body: string, missingBytes: number): typeof globalThis.fetch {
  const bytes = new TextEncoder().encode(body);
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, bytes.length - missingBytes));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof globalThis.fetch;
}

async function streamParts(
  providerType: LlmConnection['providerType'],
  fetch: typeof globalThis.fetch,
): Promise<{ reasoning: string; text: string }> {
  const model = getAIModel({
    connection: conn(providerType),
    apiKey: 'test-key',
    modelId: providerType === 'deepseek' ? 'deepseek-v4-flash' : 'grok-4.5',
    fetch,
  });
  const { stream } = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    providerOptions: { openai: { store: false, forceReasoning: true } },
  });
  let reasoning = '';
  let text = '';
  for await (const part of stream) {
    if (part.type === 'reasoning-delta') reasoning += part.delta;
    if (part.type === 'text-delta') text += part.delta;
  }
  return { reasoning, text };
}

describe('open responses plaintext reasoning', () => {
  test('streamed reasoning text reaches the model stream', async () => {
    const deltas = ['The user asks if 91 is prime. ', '91 = 7 x 13, ', 'so it is composite.'];
    const parts = await streamParts('deepseek', sseFetch(deepseekReasoningStream(deltas)));
    assert.equal(parts.reasoning, deltas.join(''));
    assert.equal(parts.text, ANSWER);
  });

  test('everything the transport does not translate passes through untouched', async () => {
    // The transport rewrites every response body from this provider, so the
    // reply it is not there to change is the one thing most worth pinning:
    // dropping message frames wholesale would otherwise leave the suite green.
    const parts = await streamParts(
      'deepseek',
      sseFetch(deepseekReasoningStream(['thinking'], 'The answer is 42.')),
    );
    assert.equal(parts.text, 'The answer is 42.');
  });

  test('reasoning survives frames split across chunk boundaries', async () => {
    // SSE frames arrive on arbitrary byte boundaries, so a translator that
    // assumes one whole event per chunk loses text without failing loudly.
    // The text is deliberately not ASCII: DeepSeek reasons in the language it
    // was asked in, and a 7-byte chunk cuts these characters mid-sequence, so
    // this also pins the decoder's cross-chunk state.
    const deltas = ['用户问 91 是不是质数。', '91 = 7 × 13，', '所以它是合数。'];
    const parts = await streamParts('deepseek', sseFetch(deepseekReasoningStream(deltas), 7));
    assert.equal(parts.reasoning, deltas.join(''));
    assert.equal(parts.text, ANSWER);
  });

  test('a provider we have not measured is left untranslated', async () => {
    // The transport is mounted per provider, not per wire. xAI reaches the same
    // Responses wire but its reasoning shape has not been measured, so nothing
    // should rewrite its stream on the strength of the wire alone.
    const parts = await streamParts('xai', sseFetch(deepseekReasoningStream(['ignored'])));
    assert.equal(parts.reasoning, '');
    assert.equal(parts.text, ANSWER);
  });

  test('non-streaming reasoning content is read', async () => {
    let body: string | undefined;
    const fetch = (async () => {
      body = JSON.stringify({
        id: 'r',
        object: 'response',
        created_at: 0,
        model: 'deepseek-v4-flash',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            id: ITEM_ID,
            summary: [],
            content: [{ type: 'reasoning_text', text: REASONING }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: { openai: { store: false, forceReasoning: true } },
    });
    const reasoning = result.content.filter((part) => part.type === 'reasoning');
    assert.equal(reasoning.length, 1);
    assert.equal(reasoning[0].text, REASONING);
  });

  test('the position of a reasoning part is carried across, not flattened', async () => {
    // Read at the transport rather than end to end: the SDK opens a second
    // reasoning part only on `reasoning_summary_part.added`, which no measured
    // provider sends, so a fixture producing one would describe nobody. What
    // the transport owns is narrower and testable on its own — `content_index`
    // names the same position `summary_index` does, and collapsing it to 0
    // would merge parts the provider kept apart.
    const source = [
      `data: ${JSON.stringify({ type: 'response.reasoning_text.delta', content_index: 2, delta: 'x', item_id: ITEM_ID })}`,
      'data: [DONE]',
      '',
    ].join('\n\n');
    const translated = createOpenAiResponsesPlaintextReasoningTransport(sseFetch(source))(
      'https://example.invalid',
    );
    const body = await (await translated).text();
    const event = JSON.parse(
      body
        .split('\n')
        .find((line) => line.includes('summary_index'))
        ?.slice('data: '.length) ?? '',
    );
    assert.equal(event.type, 'response.reasoning_summary_text.delta');
    assert.equal(event.summary_index, 2);
    assert.equal('content_index' in event, false);
  });

  test('a truncated body does not swallow the bytes it cut through', async () => {
    // A character split across a chunk boundary completes when the next chunk
    // lands, so only a body that ends mid-sequence leaves bytes inside the
    // decoder. Those bytes belong to the caller either way: released, they
    // surface as a replacement character; held, they vanish with no trace that
    // the stream was cut. Read at the transport because the SDK's event parser
    // discards an unterminated final line whatever it holds.
    const truncated = truncatingFetch(`data: 合数`, 1);
    const translated =
      await createOpenAiResponsesPlaintextReasoningTransport(truncated)('https://example.invalid');
    assert.equal(await translated.text(), 'data: 合�');
  });

  test('rewritten bodies do not keep the old body framing headers', async () => {
    // The body is re-encoded, so a copied `content-length` describes something
    // that no longer exists.
    const source = `data: ${JSON.stringify({ type: 'response.reasoning_text.delta', content_index: 0, delta: 'x', item_id: ITEM_ID })}\n\n`;
    const framed = (async () =>
      new Response(source, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'content-length': String(source.length),
          'content-encoding': 'gzip',
        },
      })) as unknown as typeof globalThis.fetch;
    const translated =
      await createOpenAiResponsesPlaintextReasoningTransport(framed)('https://example.invalid');
    assert.equal(translated.headers.get('content-length'), null);
    assert.equal(translated.headers.get('content-encoding'), null);
    assert.equal(translated.headers.get('content-type'), 'text/event-stream');
  });

  test('a summary the provider populated itself is left alone', async () => {
    // Filling a gap is safe; overwriting is not. A provider that speaks both
    // shapes keeps whatever it chose to put in the summary.
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'r',
          object: 'response',
          created_at: 0,
          model: 'deepseek-v4-flash',
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              id: ITEM_ID,
              summary: [{ type: 'summary_text', text: 'provider summary' }],
              content: [{ type: 'reasoning_text', text: REASONING }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: { openai: { store: false, forceReasoning: true } },
    });
    const reasoning = result.content.filter((part) => part.type === 'reasoning');
    assert.deepEqual(
      reasoning.map((part) => part.text),
      ['provider summary'],
    );
  });
});
