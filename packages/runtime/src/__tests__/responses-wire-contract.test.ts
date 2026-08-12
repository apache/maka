import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { modelMetadataIdsForProvider } from '@maka/core/model-metadata';
import { PROVIDER_REGISTRY } from '@maka/core/llm-connections';
import { thinkingVariantsForModel } from '@maka/core/model-thinking';
import { buildProviderOptions, getAIModel } from '@maka/runtime/model-factory';
import { z } from 'zod';
import { routeApplyPatchTools } from '../apply-patch-profile.js';
import { resolveModelRuntime } from '../model-runtime.js';
import { lowerModelTools } from '../model-adapter.js';

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

/**
 * Every Responses wire is dialled through `createOpenAI(...).responses(...)` in
 * `getAIModel`, whatever the adapter kind is — the native OpenAI provider is the
 * only one that speaks it. Its provider-options namespace is `openai`, and the
 * SDK reads no other one: the Responses model picks its namespace by asking
 * whether its own provider name contains `azure`, and only that Azure case ever
 * retries under `openai`. `parseProviderOptions` itself reads the one namespace
 * it is handed and nothing else, so options filed under a compatible provider's
 * own namespace are not dropped by a fallback that missed — they are never
 * looked at.
 */
function openAiNamespace(options: Record<string, unknown>): Record<string, unknown> | undefined {
  const inner = options.openai;
  return typeof inner === 'object' && inner !== null
    ? (inner as Record<string, unknown>)
    : undefined;
}

describe('responses wire contract', () => {
  test('every Responses model asks for encrypted reasoning', () => {
    // `store: false` is not a privacy preference here, it is the switch that
    // makes the SDK add `include: ['reasoning.encrypted_content']` and drop
    // reasoning items that came back without one. Asking is the only way a
    // provider that speaks that contract can hand back a replayable chain;
    // for one that does not, the drop stops us shipping empty husks. This
    // asserts we ask — not that any given provider answers, and not that
    // encrypted content is the only dialect a provider may carry reasoning in.
    const gaps: string[] = [];
    for (const providerType of Object.keys(PROVIDER_REGISTRY) as LlmConnection['providerType'][]) {
      if (PROVIDER_REGISTRY[providerType].runtimeAdapter?.kind === 'unavailable') continue;
      const modelIds = new Set([
        ...PROVIDER_REGISTRY[providerType].fallbackModels,
        ...modelMetadataIdsForProvider(providerType),
      ]);
      for (const modelId of modelIds) {
        let wire: string;
        try {
          wire = resolveModelRuntime({ providerType }, modelId).wire;
        } catch {
          continue;
        }
        if (wire !== 'openai-responses') continue;
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
      providerOptions: { openai: { store: false } },
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

  test('a non-OpenAI-named Responses model still asks for encrypted reasoning', async () => {
    // The options shape alone does not prove the wire: the SDK only adds the
    // include when it also believes the model reasons, and it decides that by
    // parsing the model id. `deepseek-v4-flash` fails that parse, so this
    // asserts the body the provider actually receives rather than the options
    // we hand the SDK. Without `forceReasoning` the include silently vanishes
    // while the options still look right.
    let body: Record<string, unknown> | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
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
    assert.deepEqual(body?.include, ['reasoning.encrypted_content']);
    assert.equal((body?.reasoning as { effort?: string } | undefined)?.effort, 'max');
  });
});
