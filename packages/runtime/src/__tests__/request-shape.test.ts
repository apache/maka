import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeToolSet,
  toolSchemaCharsForDiagnostics,
  computeRequestShapeDiagnostic,
} from '../request-shape.js';
import * as requestShape from '../request-shape.js';
import type { MakaTool } from '../tool-runtime.js';

function tool(name: string): MakaTool {
  return {
    name,
    description: name,
    parameters: {},
    impl: () => ({}),
  };
}

const invalid = tool('invalid');

describe('canonicalizeToolSet active allow-list', () => {
  test('a tool absent from the active set is withheld; the set drives visibility', () => {
    const { activeTools } = canonicalizeToolSet(
      [tool('Read'), tool('Rive'), tool('load_tools')],
      invalid,
      new Set(['Read', 'load_tools']),
    );
    assert.ok(activeTools.includes('Read'), 'Read is in the active set');
    assert.ok(activeTools.includes('load_tools'), 'load_tools is in the active set');
    assert.ok(!activeTools.includes('Rive'), 'Rive is absent from the active set, so hidden');
  });

  test('a tool becomes active once it is in the active set', () => {
    const { activeTools } = canonicalizeToolSet(
      [tool('Read'), tool('Rive')],
      invalid,
      new Set(['Read', 'Rive']),
    );
    assert.ok(activeTools.includes('Rive'), 'Rive is now in the active set');
  });

  test('providerTools keeps the full registry for dispatch; invalid present but not advertised', () => {
    const { providerTools, activeTools } = canonicalizeToolSet(
      [tool('Read'), tool('Rive')],
      invalid,
      new Set(['Read']),
    );
    const names = providerTools.map((t) => t.name);
    assert.ok(names.includes('Read'));
    assert.ok(names.includes('Rive'), 'a hidden tool stays dispatchable in providerTools');
    assert.ok(names.includes('invalid'), 'repair target present in providerTools');
    assert.ok(!activeTools.includes('invalid'), 'invalid is never advertised to the model');
  });
});

describe('diagnostics measure the provider-visible (active) tool subset', () => {
  const connection = { providerType: 'openai', slug: 'c' } as never;

  function rich(name: string, schema: unknown): MakaTool {
    return { name, description: name, parameters: schema, impl: () => ({}) };
  }

  function diag(
    providerTools: MakaTool[],
    activeTools: string[],
    prior?: ReturnType<typeof computeRequestShapeDiagnostic>,
  ) {
    return computeRequestShapeDiagnostic(
      {
        connection,
        modelId: 'm',
        systemPrompt: 's',
        providerOptions: {},
        providerTools,
        activeTools,
        priorMessages: [],
      },
      prior,
    );
  }

  test('char count excludes an inactive tool schema', () => {
    const tools = [rich('Read', { a: 1 }), rich('Rive', { big: 'x'.repeat(500) })];
    const withoutRive = toolSchemaCharsForDiagnostics(tools, ['Read']);
    const withRive = toolSchemaCharsForDiagnostics(tools, ['Read', 'Rive']);
    assert.ok(
      withRive > withoutRive + 400,
      'activating Rive should add its schema chars to the count',
    );
  });

  test('toolSchemaHash ignores an INACTIVE tool schema change', () => {
    const a = [rich('Read', { a: 1 }), rich('Rive', { v: 1 })];
    const b = [rich('Read', { a: 1 }), rich('Rive', { v: 2 })];
    assert.equal(
      diag(a, ['Read']).componentHashes.toolSchemaHash,
      diag(b, ['Read']).componentHashes.toolSchemaHash,
      'a change to an unadvertised schema must not move the hash',
    );
  });

  test('activating a hidden tool moves toolSchemaHash and reports tool_schema_changed', () => {
    const tools = [rich('Read', { a: 1 }), rich('Rive', { v: 1 })];
    const before = diag(tools, ['Read']);
    const after = diag(tools, ['Read', 'Rive'], before);
    assert.notEqual(after.componentHashes.toolSchemaHash, before.componentHashes.toolSchemaHash);
    assert.equal(after.prefixChangeReason, 'tool_schema_changed');
  });
});

describe('prepared provider request capture', () => {
  test('records cacheable request segments in provider-prefix order', () => {
    const capture = Reflect.get(requestShape, 'capturePreparedProviderRequest') as
      | ((input: {
          providerId: string;
          modelId: string;
          instructions: string;
          messages: Array<{ role: string; content: string }>;
          tools: Array<Record<string, unknown>>;
          providerOptions: Record<string, unknown>;
        }) => {
          requestHash: string;
          requestBytes: number;
          serializedRequest: string;
          segments: Array<{
            kind: string;
            index: number;
            cacheable: boolean;
            hash: string;
            bytes: number;
            role?: string;
          }>;
        })
      | undefined;

    assert.equal(typeof capture, 'function');
    const result = capture!({
      providerId: 'anthropic',
      modelId: 'claude-test',
      instructions: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'Bash', description: 'Run a command', inputSchema: { type: 'object' } }],
      providerOptions: { anthropic: { thinking: { type: 'enabled', budgetTokens: 1_024 } } },
    });

    assert.deepEqual(
      result.segments.map(({ kind, index, cacheable, role }) => ({
        kind,
        index,
        cacheable,
        ...(role ? { role } : {}),
      })),
      [
        { kind: 'tool_schema', index: 0, cacheable: true },
        { kind: 'system_prompt', index: 0, cacheable: true },
        { kind: 'message', index: 0, cacheable: true, role: 'user' },
        { kind: 'provider_options', index: 0, cacheable: false },
      ],
    );
    assert.match(result.requestHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.requestBytes, Buffer.byteLength(result.serializedRequest, 'utf8'));
    assert.ok(result.segments.every((segment) => segment.bytes > 0));
    assert.ok(result.segments.every((segment) => /^sha256:[a-f0-9]{64}$/.test(segment.hash)));
  });

  test('names a tool schema from the payload, and only that segment kind', () => {
    // A size nobody can attribute is not actionable: "tool definitions are 40%"
    // names no tool to remove (#2323).
    const result = requestShape.capturePreparedProviderRequest({
      providerId: 'anthropic',
      modelId: 'claude-test',
      instructions: 'system',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'Bash', inputSchema: { type: 'object' } }, { inputSchema: {} }],
      providerOptions: {},
    });

    const labels = result.segments.map((segment) => [segment.kind, segment.label] as const);
    assert.deepEqual(labels, [
      ['tool_schema', 'Bash'],
      // A tool the payload does not name gets no invented one.
      ['tool_schema', undefined],
      ['system_prompt', undefined],
      ['message', undefined],
      ['provider_options', undefined],
    ]);
  });

  test('versions and hashes non-provider-options request parameters for comparison', () => {
    const capture = (providerOptions: Record<string, unknown>, maxOutputTokens?: number) =>
      requestShape.capturePreparedProviderRequest({
        providerId: 'provider',
        modelId: 'k3',
        instructions: 'system',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'Read', inputSchema: { type: 'object' } }],
        providerOptions,
        requestPayload: {
          prompt: [{ role: 'user', content: 'hello' }],
          tools: [{ name: 'Read', inputSchema: { type: 'object' } }],
          providerOptions,
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        },
      });

    const anthropic = capture({ anthropic: { effort: 'max' } }, 131_072);
    const openai = capture({ kimiCodingPlan: { reasoningEffort: 'max' } }, 131_072);
    const changedSharedParameter = capture({ kimiCodingPlan: { reasoningEffort: 'max' } }, 32_768);

    assert.equal(anthropic.schemaVersion, 2);
    assert.equal(
      anthropic.requestPayloadWithoutProviderOptionsHash,
      openai.requestPayloadWithoutProviderOptionsHash,
    );
    assert.notEqual(
      anthropic.requestPayloadWithoutProviderOptionsHash,
      changedSharedParameter.requestPayloadWithoutProviderOptionsHash,
    );
  });

  test('keeps reasoning effort across provider namespaces in the protocol-independent hash', () => {
    const hash = (providerOptions: Record<string, unknown>, maxOutputTokens: number) =>
      requestShape.capturePreparedProviderRequest({
        providerId: 'kimi-coding-plan',
        modelId: 'kimi-for-coding',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        providerOptions,
        requestPayload: {
          prompt: [{ role: 'user', content: 'hello' }],
          maxOutputTokens,
          providerOptions,
        },
      }).requestPayloadWithoutProviderOptionsHash;

    const anthropicMax = hash(
      {
        anthropic: {
          effort: 'max',
          thinking: { type: 'enabled', budgetTokens: 1_024 },
        },
      },
      31_744,
    );
    const openaiMax = hash({ kimiCodingPlan: { reasoningEffort: 'max' } }, 32_768);
    const nativeOpenaiMax = hash({ openai: { reasoningEffort: 'max' } }, 32_768);
    const nativeOpenaiHigh = hash({ openai: { reasoningEffort: 'high' } }, 32_768);
    const zaiHigh = hash({ 'zai-coding-plan': { reasoningEffort: 'high' } }, 32_768);
    const zaiLow = hash({ 'zai-coding-plan': { reasoningEffort: 'low' } }, 32_768);

    assert.equal(anthropicMax, openaiMax);
    assert.equal(anthropicMax, nativeOpenaiMax);
    assert.equal(nativeOpenaiHigh, zaiHigh);
    assert.notEqual(zaiHigh, zaiLow);
    assert.notEqual(anthropicMax, hash({ kimiCodingPlan: { reasoningEffort: 'low' } }, 32_768));
    assert.notEqual(anthropicMax, hash({ kimiCodingPlan: { reasoningEffort: 'none' } }, 32_768));
  });

  test('normalizes Anthropic thinking budget into the protocol-independent output limit', () => {
    const capture = (providerOptions: Record<string, unknown>, maxOutputTokens: number) =>
      requestShape.capturePreparedProviderRequest({
        providerId: 'kimi-coding-plan',
        modelId: 'kimi-for-coding',
        instructions: 'system',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        providerOptions,
        requestPayload: {
          prompt: [{ role: 'user', content: 'hello' }],
          maxOutputTokens,
          providerOptions,
        },
      });

    const anthropic = capture(
      { anthropic: { thinking: { type: 'enabled', budgetTokens: 1_024 } } },
      31_744,
    );
    const openai = capture({ maka: { kimiReasoningField: 'reasoning_content' } }, 32_768);

    assert.equal(
      anthropic.requestPayloadWithoutProviderOptionsHash,
      openai.requestPayloadWithoutProviderOptionsHash,
    );
    assert.notEqual(anthropic.requestHash, openai.requestHash);
  });

  test('excludes provider metadata nested in prompt messages and parts', () => {
    const capture = (prompt: unknown[], tools: unknown[] = []) =>
      requestShape.capturePreparedProviderRequest({
        providerId: 'provider',
        modelId: 'model',
        messages: prompt,
        tools,
        requestPayload: { prompt, tools },
      });
    const sharedPrompt = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'analysis' }],
      },
    ];
    const anthropicPrompt = [
      {
        role: 'assistant',
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        content: [
          {
            type: 'reasoning',
            text: 'analysis',
            providerOptions: { anthropic: { signature: 'signed-reasoning' } },
          },
        ],
      },
    ];

    assert.equal(
      capture(anthropicPrompt).requestPayloadWithoutProviderOptionsHash,
      capture(sharedPrompt).requestPayloadWithoutProviderOptionsHash,
    );

    const sharedToolPrompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'Inspect',
            output: { type: 'content', value: [{ type: 'text', text: 'done' }] },
          },
        ],
      },
    ];
    const providerToolPrompt = [
      {
        ...sharedToolPrompt[0],
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
        content: [
          {
            ...sharedToolPrompt[0]!.content[0],
            providerOptions: { anthropic: { toolUseId: 'provider-call-1' } },
            output: {
              type: 'content',
              providerOptions: { anthropic: { resultId: 'provider-result-1' } },
              value: [
                {
                  type: 'text',
                  text: 'done',
                  providerOptions: { anthropic: { blockId: 'provider-block-1' } },
                },
              ],
            },
          },
        ],
      },
    ];
    const sharedTools = [{ type: 'function', name: 'Inspect', inputSchema: { type: 'object' } }];
    const providerTools = [
      {
        ...sharedTools[0],
        providerOptions: { anthropic: { deferLoading: true } },
      },
    ];

    assert.equal(
      capture(providerToolPrompt, providerTools).requestPayloadWithoutProviderOptionsHash,
      capture(sharedToolPrompt, sharedTools).requestPayloadWithoutProviderOptionsHash,
    );
  });

  test('normalizes provider-local tool and approval bookkeeping', () => {
    const hash = (prompt: unknown[]) =>
      requestShape.capturePreparedProviderRequest({
        providerId: 'provider',
        modelId: 'model',
        messages: prompt,
        tools: [],
        requestPayload: { prompt, tools: [] },
      }).requestPayloadWithoutProviderOptionsHash;
    const prompt = (suffix: string, approved: boolean) => [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: `call-${suffix}`,
            toolName: 'Inspect',
            input: { path: 'README.md' },
            providerExecuted: suffix === 'anthropic',
          },
          {
            type: 'tool-approval-request',
            approvalId: `approval-${suffix}`,
            toolCallId: `call-${suffix}`,
            isAutomatic: suffix === 'anthropic',
            signature: `signature-${suffix}`,
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: `call-${suffix}`,
            toolName: 'Inspect',
            output: { type: 'text', value: 'done' },
          },
          {
            type: 'tool-approval-response',
            approvalId: `approval-${suffix}`,
            approved,
            providerExecuted: suffix === 'anthropic',
          },
        ],
      },
    ];

    assert.equal(hash(prompt('anthropic', true)), hash(prompt('openai', true)));
    assert.notEqual(hash(prompt('anthropic', true)), hash(prompt('openai', false)));
  });

  test('preserves same-named fields inside user data and tool schemas', () => {
    const hash = (prompt: unknown[], tools: unknown[] = []) =>
      requestShape.capturePreparedProviderRequest({
        providerId: 'provider',
        modelId: 'model',
        messages: prompt,
        tools,
        requestPayload: { prompt, tools },
      }).requestPayloadWithoutProviderOptionsHash;
    const toolCall = (value: string) => [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'Inspect',
            input: { providerOptions: value },
          },
        ],
      },
    ];
    const toolResult = (value: string) => [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'Inspect',
            output: { type: 'json', value: { providerOptions: value } },
          },
        ],
      },
    ];
    const tool = (description: string) => [
      {
        type: 'function',
        name: 'Inspect',
        inputSchema: {
          type: 'object',
          properties: { providerOptions: { type: 'string', description } },
        },
      },
    ];

    assert.notEqual(hash(toolCall('alpha')), hash(toolCall('bravo')));
    assert.notEqual(hash(toolResult('alpha')), hash(toolResult('bravo')));
    assert.notEqual(hash([], tool('alpha')), hash([], tool('bravo')));
  });

  test('finds the first changed cacheable segment by exact content hash', () => {
    const capture = requestShape.capturePreparedProviderRequest;
    const findFirstChanged = Reflect.get(requestShape, 'findFirstChangedCacheableSegment') as
      | ((
          current: ReturnType<typeof capture>,
          prior: ReturnType<typeof capture>,
        ) => { kind: string; index: number; role?: string } | undefined)
      | undefined;
    assert.equal(typeof findFirstChanged, 'function');

    const prior = capture({
      providerId: 'openai',
      modelId: 'gpt-test',
      instructions: 'system',
      messages: [{ role: 'user', content: 'alpha' }],
      tools: [{ name: 'Read', inputSchema: { type: 'object' } }],
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });
    const changedMessage = capture({
      providerId: 'openai',
      modelId: 'gpt-test',
      instructions: 'system',
      messages: [{ role: 'user', content: 'bravo' }],
      tools: [{ name: 'Read', inputSchema: { type: 'object' } }],
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });
    assert.deepEqual(findFirstChanged!(changedMessage, prior), {
      kind: 'message',
      index: 0,
      role: 'user',
    });

    const onlyOptionsChanged = capture({
      providerId: 'openai',
      modelId: 'gpt-test',
      instructions: 'system',
      messages: [{ role: 'user', content: 'alpha' }],
      tools: [{ name: 'Read', inputSchema: { type: 'object' } }],
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    assert.equal(findFirstChanged!(onlyOptionsChanged, prior), undefined);

    const appendedMessage = capture({
      providerId: 'openai',
      modelId: 'gpt-test',
      instructions: 'system',
      messages: [
        { role: 'user', content: 'alpha' },
        { role: 'assistant', content: 'done' },
      ],
      tools: [{ name: 'Read', inputSchema: { type: 'object' } }],
      providerOptions: { openai: { reasoningEffort: 'low' } },
    });
    assert.deepEqual(findFirstChanged!(appendedMessage, prior), {
      kind: 'message',
      index: 1,
      role: 'assistant',
    });
  });
});
