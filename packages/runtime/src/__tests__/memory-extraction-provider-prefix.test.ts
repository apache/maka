import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import { ModelAdapter } from '../model-adapter.js';
import { getAIModel } from '../model-factory.js';
import type { ModelToolSet } from '../model-protocol.js';
import {
  generateProviderPrefixModelCall,
  generateToolFreeModelCall,
} from '../tool-free-model-call.js';

describe('Memory Extraction provider prefix', () => {
  test('disables Tools only for the auxiliary request while preserving the source prefix', async () => {
    const sourceRequests: Record<string, unknown>[] = [];
    let extractionRequest: Record<string, unknown> | undefined;
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const sourceModel = new MockLanguageModelV4({
      doStream: async (request) => {
        sourceRequests.push(request as unknown as Record<string, unknown>);
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage,
            },
          ]),
        };
      },
    });
    const extractionModel = new MockLanguageModelV4({
      doGenerate: async (request) => {
        extractionRequest = request as unknown as Record<string, unknown>;
        return {
          content: [{ type: 'text', text: '{}' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        };
      },
    });
    const providerOptions = { openai: { reasoningEffort: 'medium' } };
    const messages = [{ role: 'user' as const, content: 'Remember concise answers.' }];
    const tools: ModelToolSet = {
      Read: { description: 'Read a file', inputSchema: z.object({ path: z.string() }) },
      memory_remember: { description: 'Remember', inputSchema: z.object({}).strict() },
    };
    const activeTools = ['Read', 'memory_remember'];
    const adapter = new ModelAdapter({
      connection: { providerType: 'openai' } as never,
      apiKey: 'test',
      modelId: 'mock',
      modelFactory: () => sourceModel,
      newId: () => 'id',
      now: () => 0,
      providerOptions,
    });

    const stream = await adapter.startStream({
      model: sourceModel,
      messages,
      tools,
      activeTools,
      onStreamActivity: () => {},
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
      system: 'source system',
    });
    for await (const _event of stream.events) {
      void _event;
    }

    await generateProviderPrefixModelCall({
      model: extractionModel,
      system: 'source system',
      messages: [...messages, { role: 'user', content: 'Extract long-term memory as JSON.' }],
      tools,
      activeTools,
      providerOptions,
      toolChoicePolicy: 'none',
    });

    const secondStream = await adapter.startStream({
      model: sourceModel,
      messages,
      tools,
      activeTools,
      onStreamActivity: () => {},
      abortSignal: new AbortController().signal,
      repairToolCall: async () => null,
      system: 'source system',
    });
    for await (const _event of secondStream.events) {
      void _event;
    }

    assert.equal(sourceRequests.length, 2);
    assert.ok(extractionRequest);
    const sourceRequest = sourceRequests[0]!;
    const sourcePrompt = sourceRequest.prompt as readonly unknown[];
    const extractionPrompt = extractionRequest.prompt as readonly unknown[];
    assert.deepEqual(extractionPrompt.slice(0, sourcePrompt.length), sourcePrompt);
    assert.deepEqual(
      extractionPrompt.at(-1),
      expectProviderMessage('user', 'Extract long-term memory as JSON.'),
    );
    assert.deepEqual(extractionRequest.tools, sourceRequest.tools);
    assert.deepEqual(extractionRequest.toolChoice, { type: 'none' });
    assert.deepEqual(sourceRequests[1]!.toolChoice, sourceRequest.toolChoice);
    assert.deepEqual(extractionRequest.providerOptions, sourceRequest.providerOptions);
    assert.equal(extractionRequest.maxOutputTokens, sourceRequest.maxOutputTokens);
  });

  test('rejects a provider Tool Call even when toolChoice none was requested', async () => {
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 0, reasoning: 0 },
    };
    const violatingModel = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'unexpected-call',
            toolName: 'Read',
            input: '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage,
        warnings: [],
      }),
    });

    await assert.rejects(
      generateProviderPrefixModelCall({
        model: violatingModel,
        messages: [{ role: 'user', content: 'Return JSON only.' }],
        tools: { Read: { description: 'Read', inputSchema: z.object({}).strict() } },
        activeTools: ['Read'],
        toolChoicePolicy: 'none',
      }),
      /Provider returned a disabled Tool Call/,
    );
  });

  test('keeps Tool schemas on the Anthropic wire while Runtime owns call rejection', async () => {
    let body: Record<string, unknown> | undefined;
    const connection: LlmConnection = {
      slug: 'anthropic-memory-test',
      name: 'Anthropic memory test',
      providerType: 'anthropic',
      baseUrl: 'https://anthropic.invalid',
      defaultModel: 'claude-sonnet-4-6',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const model = getAIModel({
      connection,
      apiKey: 'test-key',
      modelId: connection.defaultModel,
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: 'msg_memory',
            type: 'message',
            role: 'assistant',
            model: connection.defaultModel,
            content: [{ type: 'text', text: '{}' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    await generateProviderPrefixModelCall({
      model,
      system: 'source system',
      messages: [{ role: 'user', content: 'Extract memory.' }],
      tools: { Read: { description: 'Read', inputSchema: z.object({ path: z.string() }) } },
      activeTools: ['Read'],
      toolChoicePolicy: 'omit',
    });

    assert.ok(body);
    assert.deepEqual(
      (body.tools as Array<{ name: string }>).map(({ name }) => name),
      ['Read'],
    );
    assert.deepEqual(body?.tool_choice, { type: 'auto' });
  });

  test('does not dispatch any auxiliary transport with active provider-native Tools', async () => {
    for (const toolChoicePolicy of ['none', 'omit'] as const) {
      let dispatched = false;
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          dispatched = true;
          throw new Error('provider request must not run');
        },
      });

      await assert.rejects(
        generateProviderPrefixModelCall({
          model,
          messages: [{ role: 'user', content: 'Extract memory without using tools.' }],
          tools: {
            WebSearch: {
              kind: 'provider',
              providerTool: { kind: 'anthropic-web-search-20250305', maxUses: 8 },
            },
          },
          activeTools: ['WebSearch'],
          toolChoicePolicy,
        }),
        /unavailable with active provider-native Tools/,
      );
      assert.equal(dispatched, false, `${toolChoicePolicy} must fail before provider dispatch`);
    }
  });

  test('disables AI SDK retries for the isolated canonicalizer request', async () => {
    let dispatches = 0;
    const connection: LlmConnection = {
      slug: 'canonicalizer-retry-test',
      name: 'Canonicalizer retry test',
      providerType: 'openai',
      baseUrl: 'https://openai.invalid/v1',
      defaultModel: 'gpt-test',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const model = getAIModel({
      connection,
      apiKey: 'test-key',
      modelId: connection.defaultModel,
      fetch: async () => {
        dispatches += 1;
        return new Response(JSON.stringify({ error: { message: 'temporary failure' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await assert.rejects(
      generateToolFreeModelCall({
        model,
        prompt: 'Canonicalize validated user evidence.',
        maxOutputTokens: 128,
        maxRetries: 0,
      }),
    );
    assert.equal(dispatches, 1);
  });
});

function expectProviderMessage(role: string, text: string): Record<string, unknown> {
  return { role, content: [{ type: 'text', text }], providerOptions: undefined };
}
