import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { getAIModel } from '../model-factory.js';
import { resolveModelNativePdfInputSupport } from '../model-runtime.js';

function connection(providerType: LlmConnection['providerType'], modelId: string): LlmConnection {
  return {
    slug: `${providerType}-pdf-test`,
    name: `${providerType} PDF test`,
    providerType,
    baseUrl: 'https://provider.invalid/v1',
    defaultModel: modelId,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('native PDF input gate', () => {
  test('authorizes only PDF-capable models on supported provider identities and wires', () => {
    assert.equal(
      resolveModelNativePdfInputSupport(
        connection('anthropic', 'claude-opus-4-8'),
        'claude-opus-4-8',
      ),
      true,
    );
    assert.equal(resolveModelNativePdfInputSupport(connection('openai', 'gpt-4o'), 'gpt-4o'), true);
    assert.equal(
      resolveModelNativePdfInputSupport(connection('openai', 'gpt-5.4'), 'gpt-5.4'),
      true,
    );
  });

  test('does not infer PDF support for relays, subscriptions, or unknown models', () => {
    const declaredPdfModel = {
      id: 'relay-pdf-model',
      modalities: { input: ['text', 'pdf'] as const, output: ['text'] as const },
    };
    for (const providerType of [
      'openai-compatible',
      'openai-codex',
      'anthropic-compatible',
      'claude-subscription',
    ] as const) {
      const relay = {
        ...connection(providerType, declaredPdfModel.id),
        models: [
          {
            ...declaredPdfModel,
            modalities: {
              input: [...declaredPdfModel.modalities.input],
              output: [...declaredPdfModel.modalities.output],
            },
          },
        ],
      };
      assert.equal(
        resolveModelNativePdfInputSupport(relay, declaredPdfModel.id),
        false,
        providerType,
      );
    }
    assert.equal(
      resolveModelNativePdfInputSupport(connection('openai', 'unknown-model'), 'unknown-model'),
      false,
    );
    assert.equal(
      resolveModelNativePdfInputSupport(
        {
          ...connection('openai', 'gpt-4o'),
          models: [
            {
              id: 'gpt-4o',
              modalities: { input: ['text'], output: ['text'] },
            },
          ],
        },
        'gpt-4o',
      ),
      false,
      'an explicit provider inventory must outrank generated PDF metadata',
    );
  });
});

describe('AI SDK PDF wire lowering', () => {
  test('lowers one generic PDF file part to each verified native request shape', async () => {
    const chat = await captureRequestBody('openai', 'gpt-4o');
    assert.deepEqual(requestContentPart(chat, 'messages', 1), {
      type: 'file',
      file: {
        filename: 'brief.pdf',
        file_data: 'data:application/pdf;base64,JVBERi0=',
      },
    });

    const responses = await captureRequestBody('openai', 'gpt-5.4');
    assert.deepEqual(requestContentPart(responses, 'input', 1), {
      type: 'input_file',
      filename: 'brief.pdf',
      file_data: 'data:application/pdf;base64,JVBERi0=',
    });

    const anthropic = await captureRequestBody('anthropic', 'claude-opus-4-8');
    assert.deepEqual(requestContentPart(anthropic, 'messages', 1), {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
      title: 'brief.pdf',
    });
  });
});

function requestContentPart(
  body: Record<string, unknown>,
  field: 'messages' | 'input',
  partIndex: number,
): unknown {
  const messages = body[field];
  assert.ok(Array.isArray(messages), `${field} must be an array`);
  const firstMessage = messages[0] as { content?: unknown } | undefined;
  assert.ok(
    firstMessage && Array.isArray(firstMessage.content),
    `${field}[0].content must be an array`,
  );
  assert.ok(partIndex in firstMessage.content, `${field}[0].content[${partIndex}] must exist`);
  return firstMessage.content[partIndex];
}

async function captureRequestBody(
  providerType: 'openai' | 'anthropic',
  modelId: 'gpt-4o' | 'gpt-5.4' | 'claude-opus-4-8',
): Promise<Record<string, unknown>> {
  let requestBody: Record<string, unknown> | undefined;
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (providerType === 'anthropic') {
      return Response.json({
        id: 'msg_pdf',
        type: 'message',
        role: 'assistant',
        model: modelId,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    if (modelId === 'gpt-4o') {
      return Response.json({
        id: 'chat_pdf',
        object: 'chat.completion',
        created: 0,
        model: modelId,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    return Response.json({
      id: 'resp_pdf',
      object: 'response',
      status: 'completed',
      output: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }) as unknown as typeof globalThis.fetch;
  const model = getAIModel({
    connection: connection(providerType, modelId),
    apiKey: 'test-key',
    modelId,
    fetch,
  });

  await model.doGenerate({
    prompt: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read the PDF.' },
          {
            type: 'file',
            data: { type: 'data', data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]) },
            mediaType: 'application/pdf',
            filename: 'brief.pdf',
          },
        ],
      },
    ],
  });

  assert.ok(requestBody);
  return requestBody;
}
