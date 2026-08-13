import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { modelMetadataIdsForProvider } from '@maka/core/model-metadata';
import { PROVIDER_REGISTRY } from '@maka/core/llm-connections';
import { thinkingVariantsForModel } from '@maka/core/model-thinking';
import { buildProviderOptions, getAIModel } from '@maka/runtime/model-factory';
import { z } from 'zod';
import { routeApplyPatchTools } from '../apply-patch-profile.js';
import { resolveModelRuntime } from '../model-runtime.js';
import { lowerModelTools } from '../model-adapter.js';
import { openAiCodexCompactionMessages } from '../openai-codex-history-compactor.js';

function conn(providerType: LlmConnection['providerType'], slug = 'test'): LlmConnection {
  return {
    slug,
    name: slug,
    providerType,
    defaultModel: 'm',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** OpenAI's encrypted Responses dialect still reads the `openai` namespace. */
function openAiNamespace(options: Record<string, unknown>): Record<string, unknown> | undefined {
  const inner = options.openai;
  return typeof inner === 'object' && inner !== null
    ? (inner as Record<string, unknown>)
    : undefined;
}

describe('responses wire contract', () => {
  test('keeps Qwen3.8 Max on Token Plan Chat until the provider adapter supports Responses', () => {
    for (const providerType of ['alibaba-token-plan-cn', 'alibaba-token-plan'] as const) {
      assert.equal(
        resolveModelRuntime({ providerType }, 'qwen3.8-max').wire,
        'openai-chat',
        providerType,
      );
    }
  });

  test('every encrypted Responses dialect asks for encrypted reasoning', () => {
    // `store: false` is not a privacy preference here, it is the switch that
    // makes the SDK add `include: ['reasoning.encrypted_content']` and drop
    // reasoning items that came back without one. Asking is the only way a
    // provider that speaks that contract can hand back a replayable chain;
    // for one that does not, the drop stops us shipping empty husks. This
    // asserts we ask — not that any given provider answers, and not that
    // encrypted content is the only dialect a provider may carry reasoning in.
    const gaps: string[] = [];
    for (const providerType of Object.keys(PROVIDER_REGISTRY) as LlmConnection['providerType'][]) {
      const modelIds = new Set([
        ...PROVIDER_REGISTRY[providerType].fallbackModels,
        ...modelMetadataIdsForProvider(providerType),
      ]);
      for (const modelId of modelIds) {
        let runtime: ReturnType<typeof resolveModelRuntime>;
        try {
          runtime = resolveModelRuntime({ providerType }, modelId);
        } catch {
          continue;
        }
        if (
          runtime.wire !== 'openai-responses' ||
          runtime.reasoningReplay.kind === 'open-responses-plaintext'
        ) {
          continue;
        }
        // Sweep the declared levels and the unset case: `store` is a property
        // of the wire, not of a thinking choice, so a model reaches this branch
        // whether or not a level was picked.
        for (const level of [undefined, ...thinkingVariantsForModel(providerType, modelId)]) {
          const options = buildProviderOptions(conn(providerType), modelId, level);
          const openai = openAiNamespace(options);
          const label = `${providerType}/${modelId} @ ${level ?? 'unset'}`;
          if (!openai) {
            gaps.push(`${label} wires no openai namespace: ${JSON.stringify(options)}`);
          } else if (openai.store !== false) {
            gaps.push(`${label} omits store:false: ${JSON.stringify(options)}`);
          }
        }
      }
    }
    assert.deepEqual(gaps, []);
  });
});

describe('responses wire request body', () => {
  test('adds the V2 trigger only through the explicit OpenAI provider option', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const ordinaryModel = getAIModel({
      connection: conn('openai-codex', 'codex-subscription'),
      apiKey: 'codex-token',
      modelId: 'gpt-5.3-codex',
      fetch,
    });
    await ordinaryModel.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ordinary model' }] }],
    });

    await ordinaryModel.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'compact me' }] }],
      providerOptions: { openai: { compactionTrigger: true } },
    });
    await ordinaryModel.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ordinary request' }] }],
      providerOptions: { openai: { compactionTrigger: false } },
    });

    const ordinaryInput = bodies[0]?.input;
    const compactInput = bodies[1]?.input;
    const unmarkedInput = bodies[2]?.input;
    assert.ok(Array.isArray(ordinaryInput));
    assert.ok(Array.isArray(compactInput));
    assert.ok(Array.isArray(unmarkedInput));
    assert.equal(
      ordinaryInput.some((item) => item.type === 'compaction_trigger'),
      false,
    );
    assert.deepEqual(compactInput.at(-1), { type: 'compaction_trigger' });
    assert.equal(
      unmarkedInput.some((item) => item.type === 'compaction_trigger'),
      false,
    );
  });

  test('keeps provider-executed tool history free of dangling outputs', async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const event = (
      id: string,
      role: RuntimeEvent['role'],
      author: RuntimeEvent['author'],
      content: RuntimeEvent['content'],
      refs?: RuntimeEvent['refs'],
    ): RuntimeEvent => ({
      id,
      invocationId: 'inv-1',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 1,
      partial: false,
      role,
      author,
      content,
      ...(refs ? { refs } : {}),
    });
    const messages = openAiCodexCompactionMessages([
      event('user', 'user', 'user', { kind: 'text', text: 'search' }),
      event(
        'call',
        'model',
        'agent',
        {
          kind: 'function_call',
          id: 'search-1',
          name: 'WebSearch',
          args: { query: 'latest Maka' },
          providerExecuted: true,
        },
        { stepId: 'provider-step' },
      ),
      event('result', 'tool', 'tool', {
        kind: 'function_response',
        id: 'search-1',
        name: 'WebSearch',
        result: { type: 'web_search_result', query: 'latest Maka' },
        providerOutput: { type: 'web_search_result', id: 'ws_123' },
        providerExecuted: true,
        isError: false,
      }),
      event(
        'text',
        'model',
        'agent',
        { kind: 'text', text: 'Maka shipped.' },
        { providerEventId: 'provider-step' },
      ),
    ]);
    assert.deepEqual(
      messages.map((message) => ({
        role: message.role,
        parts:
          typeof message.content === 'string' ? ['text'] : message.content.map((part) => part.type),
      })),
      [
        { role: 'user', parts: ['text'] },
        { role: 'assistant', parts: ['tool-call'] },
        { role: 'tool', parts: ['tool-result'] },
        { role: 'assistant', parts: ['text'] },
      ],
    );

    const model = getAIModel({
      connection: conn('openai-codex', 'codex-subscription'),
      apiKey: 'codex-token',
      modelId: 'gpt-5.3-codex',
      fetch,
    });
    await model.doGenerate({
      prompt: messages as never,
      providerOptions: { openai: { store: false, compactionTrigger: true } },
    });

    const input = body?.input as Array<Record<string, unknown>>;
    const callIds = new Set(
      input.filter((item) => item.type === 'function_call').map((item) => String(item.call_id)),
    );
    const danglingOutputIds = input
      .filter((item) => item.type === 'function_call_output')
      .map((item) => String(item.call_id))
      .filter((callId) => !callIds.has(callId));
    assert.deepEqual([...callIds], ['search-1']);
    assert.deepEqual(
      input
        .filter((item) => item.type === 'function_call_output')
        .map((item) => String(item.call_id)),
      ['search-1'],
    );
    assert.deepEqual(danglingOutputIds, [], JSON.stringify(input));
  });

  test('returns native apply_patch results with the provider output item', async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const connection = conn('openai');
    const model = getAIModel({ connection, apiKey: 'test-key', modelId: 'gpt-5.4', fetch });
    const tools = lowerModelTools({
      apply_patch: { kind: 'provider', providerTool: { kind: 'openai-apply-patch' } },
    });

    await model.doGenerate({
      prompt: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'apply_patch',
              input: {
                callId: 'call-1',
                operation: { type: 'delete_file', path: 'old.txt' },
              },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'apply_patch',
              output: { type: 'json', value: { status: 'failed', output: 'conflict' } },
            },
          ],
        },
      ],
      tools: [tools.apply_patch as never],
      providerOptions: { openai: { store: false } },
    });

    assert.deepEqual((body?.input as unknown[] | undefined)?.at(-1), {
      type: 'apply_patch_call_output',
      call_id: 'call-1',
      status: 'failed',
      output: 'conflict',
    });
  });

  test('sends DeepSeek-compatible freeform apply_patch calls and plain-text results', async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const connection = conn('deepseek');
    const model = getAIModel({
      connection,
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    const patch = '*** Begin Patch\n*** Delete File: old.txt\n*** End Patch';
    const runtime = resolveModelRuntime(connection, 'deepseek-v4-flash');
    const [routedTool] = routeApplyPatchTools(
      [
        {
          name: 'apply_patch',
          description: 'Apply file changes',
          parameters: z.object({}),
          providerTool: { kind: 'openai-apply-patch' },
          impl: async () => ({ status: 'completed' }),
        },
      ],
      runtime.applyPatchProfile,
    );
    assert.ok(routedTool);
    assert.ok(routedTool.providerTool);
    assert.equal((routedTool.parameters as z.ZodType).safeParse(patch).success, true);
    assert.deepEqual(
      await routedTool.toModelOutput?.({
        toolCallId: 'call-1',
        input: patch,
        output: { status: 'completed', output: 'Applied 1 file operation.' },
      }),
      { type: 'text', value: 'Applied 1 file operation.' },
    );
    const tools = lowerModelTools({
      apply_patch: {
        kind: 'provider',
        providerTool: routedTool.providerTool,
      },
    });

    await model.doGenerate({
      prompt: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'apply_patch',
              input: patch,
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'apply_patch',
              output: { type: 'text', value: 'Applied 1 file operation.' },
            },
          ],
        },
      ],
      tools: [{ ...(tools.apply_patch as object), name: 'apply_patch' } as never],
      providerOptions: buildProviderOptions(connection, 'deepseek-v4-flash'),
    });

    assert.deepEqual((body?.tools as unknown[] | undefined)?.[0], {
      type: 'custom',
      name: 'apply_patch',
    });
    assert.deepEqual((body?.input as unknown[] | undefined)?.slice(-2), [
      { type: 'custom_tool_call', call_id: 'call-1', name: 'apply_patch', input: patch },
      {
        type: 'custom_tool_call_output',
        call_id: 'call-1',
        output: 'Applied 1 file operation.',
      },
    ]);
  });

  test('returns streamed DeepSeek custom apply_patch calls through the model interface', async () => {
    const patch = '*** Begin Patch\n*** Delete File: old.txt\n*** End Patch';
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: {
          type: 'custom_tool_call',
          id: 'custom-1',
          status: 'in_progress',
          call_id: 'call-1',
          name: 'apply_patch',
          input: '',
        },
      },
      {
        type: 'response.custom_tool_call_input.delta',
        output_index: 0,
        sequence_number: 2,
        item_id: 'custom-1',
        delta: patch,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        sequence_number: 3,
        item: {
          type: 'custom_tool_call',
          id: 'custom-1',
          status: 'completed',
          call_id: 'call-1',
          name: 'apply_patch',
          input: patch,
        },
      },
      {
        type: 'response.completed',
        sequence_number: 4,
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
    const fetch = (async () =>
      new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Delete old.txt' }] }],
      tools: [
        {
          type: 'provider',
          id: 'openai.custom',
          name: 'apply_patch',
          args: {},
        },
      ],
    });
    const parts = [];
    for await (const part of stream) {
      parts.push(part);
    }

    assert.deepEqual(
      parts.filter((part) => part.type === 'tool-call'),
      [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'apply_patch',
          input: JSON.stringify(patch),
        },
      ],
      JSON.stringify(parts),
    );
  });

  test('returns streamed DeepSeek hosted web search calls and results', async () => {
    const action = { type: 'search', queries: ['latest Maka'] };
    let requestBody: Record<string, unknown> | undefined;
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: {
          type: 'web_search_call',
          id: 'search-1',
          status: 'in_progress',
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        sequence_number: 2,
        item: {
          type: 'web_search_call',
          id: 'search-1',
          status: 'completed',
          action,
        },
      },
      {
        type: 'response.completed',
        sequence_number: 3,
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
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof globalThis.fetch;
    const model = getAIModel({
      connection: conn('deepseek'),
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'Search.' }] }],
      tools: [
        {
          type: 'provider',
          id: 'openai.web_search',
          name: 'WebSearch',
          args: { searchContextSize: 'medium' },
        },
      ],
    });
    const parts = [];
    for await (const part of stream) {
      if (part.type === 'tool-call' || part.type === 'tool-result') parts.push(part);
    }

    assert.deepEqual(parts, [
      {
        type: 'tool-call',
        toolCallId: 'search-1',
        toolName: 'WebSearch',
        input: '{}',
        providerExecuted: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'search-1',
        toolName: 'WebSearch',
        result: { action },
      },
    ]);
    assert.deepEqual(requestBody?.tools, [{ type: 'web_search', search_context_size: 'medium' }]);
  });

  test('DeepSeek uses plaintext Responses options without asking for encrypted content', async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      headers = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          id: 'r',
          object: 'response',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const connection = conn('deepseek');
    const model = getAIModel({
      connection,
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });
    await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: buildProviderOptions(connection, 'deepseek-v4-flash', 'max'),
    });

    assert.equal(body?.store, false);
    assert.equal(body?.include, undefined);
    assert.equal((body?.reasoning as { effort?: string } | undefined)?.effort, 'max');
    assert.equal(headers?.has('x-maka-open-responses-reasoning-effort'), false);
  });

  test('replays plaintext reasoning before its function call and result', async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        id: 'r',
        object: 'response',
        status: 'completed',
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof globalThis.fetch;
    const connection = conn('deepseek');
    const model = getAIModel({
      connection,
      apiKey: 'test-key',
      modelId: 'deepseek-v4-flash',
      fetch,
    });

    await model.doGenerate({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'Read package.json' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I should inspect the requested file.' },
            {
              type: 'tool-call',
              toolCallId: 'call-read',
              toolName: 'Read',
              input: { path: 'package.json' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-read',
              toolName: 'Read',
              output: { type: 'text', value: '{"name":"maka"}' },
            },
          ],
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'Read',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
    });

    const input = body?.input as Array<Record<string, unknown>> | undefined;
    assert.deepEqual(
      input?.map((item) => item.type),
      ['message', 'reasoning', 'function_call', 'function_call_output'],
    );
    assert.deepEqual(input?.[1], {
      type: 'reasoning',
      summary: [],
      content: [{ type: 'reasoning_text', text: 'I should inspect the requested file.' }],
    });
    assert.deepEqual(input?.[2], {
      type: 'function_call',
      call_id: 'call-read',
      name: 'Read',
      arguments: '{"path":"package.json"}',
    });
    assert.deepEqual(input?.[3], {
      type: 'function_call_output',
      call_id: 'call-read',
      output: '{"name":"maka"}',
    });
  });
});
