/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Executable override bindings for the provider conformance matrix.
 *
 * Every matrix cell the plan marks `override` binds here to a real, runnable
 * assertion instead of a hand-written test title. The matrix suite executes
 * each binding directly, so deleting, breaking, or orphaning an override
 * fails the matrix — there is no textual source check that a commented-out
 * test could satisfy. A plan override cell without a binding (or a binding
 * without a plan cell) fails the gap report in the matrix suite.
 *
 * Not a test file itself: node --test only runs `*.test.js`, so these bodies
 * execute exactly once, from `provider-contract-matrix.test.ts`.
 */

import assert from 'node:assert/strict';
import type { LlmConnection } from '@maka/core/llm-connections';
import { generateText, isStepCount, streamText, tool } from 'ai';
import { z } from 'zod';
import { fetchProviderModels } from '../model-fetcher.js';
import { buildProviderOptions, getAIModel } from '../model-factory.js';
import { buildSubscriptionModelFetch } from '../subscription-model-fetch.js';
import {
  readBody,
  respondJson,
  respondOpenAIStream,
  startJsonServer,
} from './conformance-harness.js';

export interface ProviderContractOverrideBinding {
  /** Plan override keys (`${providerType}:${dimension}`) this executable owns. */
  keys: readonly string[];
  /** Human-readable statement of the provider-specific contract, used as the test title. */
  title: string;
  run(): Promise<void>;
}

export const PROVIDER_CONTRACT_OVERRIDE_BINDINGS: readonly ProviderContractOverrideBinding[] = [
  {
    keys: ['github-copilot:discovery'],
    title:
      'GitHub Copilot discovers only account-enabled tool models and preserves each exact endpoint wire',
    run: runGitHubCopilotDiscovery,
  },
  {
    keys: [
      'github-copilot:exact-model-id',
      'github-copilot:tool-loop',
      'github-copilot:reasoning-replay',
    ],
    title:
      'GitHub Copilot discovers the account model and completes a reasoning tool loop on its exact wire',
    run: runGitHubCopilotWire,
  },
  {
    keys: ['fireworks-ai:discovery'],
    title:
      'Fireworks discovers exact serverless model paths and completes a two-stage tool-call loop',
    run: runFireworksDiscovery,
  },
  {
    keys: ['ollama:discovery'],
    title:
      'Ollama preserves exact local model ids (complex ids and cloud aliases) through /api/tags discovery and a no-secret tool-call loop',
    run: runOllamaDiscovery,
  },
  {
    keys: ['cohere:discovery'],
    title: 'Cohere paginates account models and completes its native V2 tool-call loop',
    run: runCohereDiscovery,
  },
  {
    keys: ['cloudflare-workers-ai:discovery'],
    title: 'Cloudflare Workers AI discovers text-generation models through its native catalog',
    run: runCloudflareDiscovery,
  },
  {
    keys: ['zenmux:reasoning-replay'],
    title: 'ZenMux replays signed reasoning details in the streamed runtime tool loop',
    run: runZenMuxSignedReasoningReplay,
  },
  {
    keys: ['deepseek:reasoning-replay'],
    title: 'DeepSeek replays plaintext reasoning content on its Responses wire',
    run: () =>
      runOpenAIResponsesWire({
        providerType: 'deepseek',
        slug: 'deepseek',
        name: 'DeepSeek',
        basePath: '/v1',
        modelId: 'deepseek-v4-flash',
        apiKey: 'deepseek-test-key',
        plaintextReasoning: true,
      }),
  },
  {
    keys: ['xai:reasoning-replay', 'xai-oauth:reasoning-replay'],
    title: 'xAI API-key and OAuth paths retain encrypted Responses reasoning',
    run: async () => {
      for (const input of [
        { providerType: 'xai' as const, slug: 'xai', apiKey: 'xai-test-key' },
        {
          providerType: 'xai-oauth' as const,
          slug: 'xai-oauth',
          apiKey: 'xai-oauth-test-token',
        },
      ]) {
        await runOpenAIResponsesWire({
          ...input,
          name: input.slug,
          basePath: `/${input.slug}/v1`,
          modelId: 'grok-4.5',
          statelessReasoning: true,
        });
      }
    },
  },
  {
    keys: [
      'openai-responses-compatible:exact-model-id',
      'openai-responses-compatible:tool-loop',
      'openai-responses-compatible:reasoning-replay',
    ],
    title: 'Custom OpenAI Responses relay preserves exact model ids and tool results',
    run: () =>
      runOpenAIResponsesWire({
        providerType: 'openai-responses-compatible',
        slug: 'responses-relay',
        name: 'Responses Relay',
        basePath: '/relay/v1',
        modelId: 'relay-responses-model',
        apiKey: 'responses-relay-key',
        statelessReasoning: true,
      }),
  },
  {
    keys: [
      'volcengine-agent-plan:exact-model-id',
      'volcengine-agent-plan:tool-loop',
      'volcengine-agent-plan:reasoning-replay',
    ],
    title: 'Volcengine Agent Plan uses its dedicated key on the OpenAI Responses tool wire',
    run: () =>
      runOpenAIResponsesWire({
        providerType: 'volcengine-agent-plan',
        slug: 'volcengine-agent-plan',
        name: 'Volcengine Ark Agent Plan (China)',
        basePath: '/api/plan/v3',
        modelId: 'ark-code-latest',
        apiKey: 'volcengine-agent-plan-test-key',
        statelessReasoning: true,
      }),
  },
  {
    keys: ['alibaba-token-plan-cn:reasoning-replay', 'alibaba-token-plan:reasoning-replay'],
    title: 'Alibaba Token Plan replays plaintext summary items on its Responses wire',
    run: runAlibabaTokenPlanResponsesWire,
  },
];

async function runAlibabaTokenPlanResponsesWire(): Promise<void> {
  for (const input of [
    {
      providerType: 'alibaba-token-plan-cn' as const,
      slug: 'alibaba-token-plan-cn',
      basePath: '/cn/compatible-mode/v1',
      apiKey: 'alibaba-token-plan-cn-key',
    },
    {
      providerType: 'alibaba-token-plan' as const,
      slug: 'alibaba-token-plan',
      basePath: '/global/compatible-mode/v1',
      apiKey: 'alibaba-token-plan-global-key',
    },
  ]) {
    const modelId = 'qwen3.8-max';
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, `${input.basePath}/responses`);
      assert.equal(request.headers.authorization, `Bearer ${input.apiKey}`);
      requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        respondJson(response, 200, {
          id: 'resp_alibaba_tool',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: modelId,
          output: [
            {
              type: 'reasoning',
              id: 'rs_alibaba_tool',
              summary: [{ type: 'summary_text', text: 'Use echo.' }],
            },
            {
              type: 'function_call',
              id: 'fc_alibaba_echo',
              call_id: 'call_alibaba_echo',
              name: 'echo',
              arguments: '{"text":"hello"}',
              status: 'completed',
            },
          ],
          usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
        });
        return;
      }
      respondJson(response, 200, {
        id: 'resp_alibaba_final',
        object: 'response',
        created_at: 2,
        status: 'completed',
        model: modelId,
        output: [
          {
            type: 'message',
            id: 'msg_alibaba_final',
            status: 'completed',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Echoed hello.', annotations: [], logprobs: [] },
            ],
          },
        ],
        usage: { input_tokens: 14, output_tokens: 3, total_tokens: 17 },
      });
    });
    const connection: LlmConnection = {
      slug: input.slug,
      name: input.slug,
      providerType: input.providerType,
      baseUrl: `${server.url}${input.basePath}`,
      defaultModel: modelId,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const result = await generateText({
      model: getAIModel({ connection, apiKey: input.apiKey, modelId }),
      prompt: 'Call echo with hello.',
      providerOptions: buildProviderOptions(connection, modelId),
      stopWhen: isStepCount(2),
      tools: {
        echo: tool({
          description: 'Echo text',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => ({ echoed: text }),
        }),
      },
    });

    assert.deepEqual(
      requestBodies.map((body) => body.model),
      [modelId, modelId],
    );
    assert.deepEqual(
      requestBodies.map((body) => body.store),
      [false, false],
    );
    assert.deepEqual(
      (requestBodies[1].input as Array<Record<string, unknown>>).find(
        ({ type }) => type === 'reasoning',
      ),
      {
        type: 'reasoning',
        id: 'rs_alibaba_tool',
        summary: [{ type: 'summary_text', text: 'Use echo.' }],
      },
    );
    assert.deepEqual(
      (requestBodies[1].input as Array<Record<string, unknown>>).find(
        ({ type }) => type === 'function_call_output',
      ),
      {
        type: 'function_call_output',
        call_id: 'call_alibaba_echo',
        output: '{"echoed":"hello"}',
      },
    );
    assert.equal(result.text, 'Echoed hello.');
  }
}

async function runCloudflareDiscovery(): Promise<void> {
  const server = await startJsonServer((request, response) => {
    assert.equal(request.method, 'GET');
    const page = new URL(request.url ?? '', 'http://test.local').searchParams.get('page');
    assert.equal(request.headers.authorization, 'Bearer cloudflare-test-token');
    respondJson(response, 200, {
      success: true,
      result:
        page === '1'
          ? [
              {
                name: '@cf/meta/llama-text',
                task: { id: 'text-generation', name: 'Text Generation' },
              },
            ]
          : [],
      result_info: { page: Number(page), per_page: 50 },
    });
  });
  const connection: LlmConnection = {
    slug: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    providerType: 'cloudflare-workers-ai',
    baseUrl: `${server.url}/client/v4/accounts/account-123/ai/v1`,
    defaultModel: '@cf/meta/llama-text',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  assert.deepEqual(await fetchProviderModels(connection, 'cloudflare-test-token'), [
    { id: '@cf/meta/llama-text' },
  ]);
}

async function runGitHubCopilotDiscovery(): Promise<void> {
  const server = await startJsonServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/models');
    assert.equal(request.headers.authorization, 'Bearer github-account-token');
    assert.equal(request.headers['user-agent'], 'GitHubCopilotChat/0.35.0');
    assert.equal(request.headers['editor-version'], 'vscode/1.107.0');
    assert.equal(request.headers['editor-plugin-version'], 'copilot-chat/0.35.0');
    assert.equal(request.headers['copilot-integration-id'], 'vscode-chat');
    assert.equal(request.headers['x-github-api-version'], '2026-06-01');
    respondJson(response, 200, {
      data: [
        copilotModel('gpt-5.4', ['/responses']),
        copilotModel('claude-sonnet-4.6', ['/v1/messages']),
        copilotModel('gemini-3.1-pro-preview', ['/chat/completions']),
        {
          ...copilotModel('disabled-by-policy', ['/chat/completions']),
          policy: { state: 'disabled' },
        },
        {
          ...copilotModel('hidden-from-picker', ['/chat/completions']),
          model_picker_enabled: false,
        },
        {
          ...copilotModel('no-tools', ['/chat/completions']),
          capabilities: { supports: { tool_calls: false } },
        },
        copilotModel('unsupported-wire', ['/embeddings']),
      ],
    });
  });

  const models = await fetchProviderModels(
    {
      slug: 'github-copilot',
      name: 'GitHub Copilot',
      providerType: 'github-copilot',
      baseUrl: server.url,
      defaultModel: 'gpt-5.4',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
    'github-account-token',
  );

  assert.deepEqual(models, [
    {
      id: 'gpt-5.4',
      displayName: 'gpt-5.4 display',
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      apiProtocol: 'openai-responses',
      capabilities: { vision: true, reasoning: true, functionCalling: true },
    },
    {
      id: 'claude-sonnet-4.6',
      displayName: 'claude-sonnet-4.6 display',
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      apiProtocol: 'anthropic-messages',
      capabilities: { vision: true, reasoning: true, functionCalling: true },
    },
    {
      id: 'gemini-3.1-pro-preview',
      displayName: 'gemini-3.1-pro-preview display',
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      apiProtocol: 'openai-chat',
      capabilities: { vision: true, reasoning: true, functionCalling: true },
    },
  ]);
}

function copilotModel(id: string, supportedEndpoints: string[]): Record<string, unknown> {
  return {
    id,
    name: `${id} display`,
    model_picker_enabled: true,
    supported_endpoints: supportedEndpoints,
    policy: { state: 'enabled' },
    capabilities: {
      limits: {
        max_prompt_tokens: 400_000,
        max_output_tokens: 128_000,
      },
      supports: {
        tool_calls: true,
        vision: true,
        reasoning_effort: ['low', 'medium', 'high'],
      },
    },
  };
}

async function runGitHubCopilotWire(): Promise<void> {
  const modelId = 'gemini-3.1-pro-preview';
  const requestBodies: Array<Record<string, unknown>> = [];
  const initiators: string[] = [];
  const server = await startJsonServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer github-account-token');
    if (request.method === 'GET' && request.url === '/models') {
      respondJson(response, 200, {
        data: [
          {
            id: modelId,
            name: 'Gemini 3.1 Pro Preview',
            model_picker_enabled: true,
            supported_endpoints: ['/chat/completions'],
            policy: { state: 'enabled' },
            capabilities: {
              limits: { max_prompt_tokens: 400_000, max_output_tokens: 64_000 },
              supports: { tool_calls: true, reasoning_effort: ['low', 'medium', 'high'] },
            },
          },
        ],
      });
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/chat/completions');
    assert.equal(request.headers['openai-intent'], 'conversation-edits');
    assert.equal(request.headers['x-github-api-version'], '2026-06-01');
    initiators.push(String(request.headers['x-initiator']));
    requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        id: 'copilot-tool',
        object: 'chat.completion',
        created: 1,
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'I should use the echo tool.',
              tool_calls: [
                {
                  id: 'call-copilot-echo',
                  type: 'function',
                  function: { name: 'echo', arguments: '{"text":"hello"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
      return;
    }
    respondJson(response, 200, {
      id: 'copilot-final',
      object: 'chat.completion',
      created: 2,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Echoed hello.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
  });
  const connection: LlmConnection = {
    slug: 'github-copilot',
    name: 'GitHub Copilot',
    providerType: 'github-copilot',
    baseUrl: server.url,
    defaultModel: modelId,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const models = await fetchProviderModels(connection, 'github-account-token');
  connection.models = models;
  const modelFetch = buildSubscriptionModelFetch({
    connection,
    sessionId: 'session-copilot',
    modelId,
    fetchFn: fetch,
  });
  assert.ok(modelFetch);

  const result = await generateText({
    model: getAIModel({
      connection,
      apiKey: 'github-account-token',
      modelId,
      fetch: modelFetch,
    }),
    prompt: 'Call echo with hello.',
    stopWhen: isStepCount(2),
    tools: {
      echo: tool({
        description: 'Echo text',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => ({ echoed: text }),
      }),
    },
  });

  assert.deepEqual(
    models.map((model) => [model.id, model.apiProtocol]),
    [[modelId, 'openai-chat']],
  );
  assert.deepEqual(initiators, ['user', 'agent']);
  assert.equal(requestBodies[0]?.model, modelId);
  assert.equal(result.steps[0]?.reasoningText, 'I should use the echo tool.');
  assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
  // Turn two must carry the exact model id, replay the assistant tool-call
  // turn (original tool_calls id + reasoning_content verbatim), and link the
  // tool result back through tool_call_id.
  assert.equal(requestBodies[1]?.model, modelId);
  const secondMessages = requestBodies[1]?.messages as Array<Record<string, unknown>>;
  const assistant = secondMessages.find((message) => message.role === 'assistant');
  assert.ok(assistant, 'turn two must replay the assistant tool-call turn');
  assert.deepEqual(
    (assistant.tool_calls as Array<{ id: string }>).map(({ id }) => id),
    ['call-copilot-echo'],
    'turn two must replay the original tool_calls id',
  );
  assert.equal(
    assistant.reasoning_content,
    'I should use the echo tool.',
    'turn two must replay the first-turn reasoning verbatim as reasoning_content',
  );
  const toolMessage = secondMessages.find((message) => message.role === 'tool');
  assert.ok(toolMessage, 'turn two must carry a tool message with the echo result');
  assert.equal(toolMessage.tool_call_id, 'call-copilot-echo');
  const toolMessageContent = JSON.stringify(toolMessage.content);
  assert.ok(
    toolMessageContent.includes('echoed') && toolMessageContent.includes('hello'),
    `turn two tool message must carry the echo output, got ${toolMessageContent}`,
  );
  assert.equal(result.text, 'Echoed hello.');
}

async function runFireworksDiscovery(): Promise<void> {
  const modelId = 'accounts/fireworks/models/kimi-k2p6';
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = await startJsonServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fireworks-test-key');
    if (request.method === 'GET' && request.url === '/v1/accounts?pageSize=200') {
      respondJson(response, 200, {
        accounts: [{ name: 'accounts/acme' }],
        nextPageToken: 'accounts-next',
      });
      return;
    }
    if (
      request.method === 'GET' &&
      request.url === '/v1/accounts?pageSize=200&pageToken=accounts-next'
    ) {
      respondJson(response, 200, { accounts: [{ name: 'accounts/team' }] });
      return;
    }
    if (
      request.method === 'GET' &&
      request.url === '/v1/accounts/acme/models?filter=supports_serverless%3Dtrue&pageSize=200'
    ) {
      respondJson(response, 200, {
        models: [
          {
            name: 'accounts/acme/models/custom-agent',
            displayName: 'Custom Agent',
            supportsTools: true,
            supportsServerless: true,
          },
        ],
        nextPageToken: 'models-next',
      });
      return;
    }
    if (
      request.method === 'GET' &&
      request.url ===
        '/v1/accounts/acme/models?filter=supports_serverless%3Dtrue&pageSize=200&pageToken=models-next'
    ) {
      respondJson(response, 200, {
        models: [
          {
            name: 'accounts/acme/models/custom-agent-v2',
            displayName: 'Custom Agent V2',
            supportsTools: true,
            supportsServerless: true,
          },
        ],
      });
      return;
    }
    if (
      request.method === 'GET' &&
      request.url === '/v1/accounts/team/models?filter=supports_serverless%3Dtrue&pageSize=200'
    ) {
      respondJson(response, 200, {
        models: [
          {
            name: 'accounts/team/models/team-agent',
            displayName: 'Team Agent',
            supportsTools: true,
            supportsServerless: true,
          },
        ],
      });
      return;
    }
    if (
      request.method === 'GET' &&
      request.url === '/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=200'
    ) {
      respondJson(response, 200, {
        models: [
          {
            name: modelId,
            displayName: 'Kimi K2.6',
            contextLength: 262_000,
            supportsImageInput: true,
            supportsTools: true,
            supportsServerless: true,
          },
        ],
      });
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/inference/v1/chat/completions');
    requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        id: 'chatcmpl-fireworks-tool',
        object: 'chat.completion',
        created: 1,
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_echo',
                  type: 'function',
                  function: { name: 'echo', arguments: '{"text":"hello"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
      return;
    }

    respondJson(response, 200, {
      id: 'chatcmpl-fireworks-final',
      object: 'chat.completion',
      created: 2,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Echoed hello.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
  });
  const connection: LlmConnection = {
    slug: 'fireworks-ai',
    name: 'Fireworks AI',
    providerType: 'fireworks-ai',
    baseUrl: `${server.url}/inference/v1`,
    defaultModel: modelId,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  const models = await fetchProviderModels(connection, 'fireworks-test-key');
  assert.deepEqual(models, [
    {
      id: 'accounts/acme/models/custom-agent',
      displayName: 'Custom Agent',
      capabilities: { functionCalling: true },
    },
    {
      id: 'accounts/acme/models/custom-agent-v2',
      displayName: 'Custom Agent V2',
      capabilities: { functionCalling: true },
    },
    {
      id: 'accounts/team/models/team-agent',
      displayName: 'Team Agent',
      capabilities: { functionCalling: true },
    },
    {
      id: modelId,
      displayName: 'Kimi K2.6',
      contextWindow: 262_000,
      capabilities: { vision: true, functionCalling: true },
    },
  ]);

  const result = await generateText({
    model: getAIModel({ connection, apiKey: 'fireworks-test-key', modelId }),
    prompt: 'Call echo with hello.',
    stopWhen: isStepCount(2),
    tools: {
      echo: tool({
        description: 'Echo text',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => ({ echoed: text }),
      }),
    },
  });

  assert.deepEqual(
    requestBodies.map((body) => body.model),
    [modelId, modelId],
  );
  assert.deepEqual(
    (requestBodies[1].messages as Array<{ role: string; content: string }>).find(
      ({ role }) => role === 'tool',
    ),
    { role: 'tool', content: '{"echoed":"hello"}', tool_call_id: 'call_echo' },
  );
  assert.equal(result.text, 'Echoed hello.');
}

async function runOllamaDiscovery(): Promise<void> {
  // Complex local model id, then a cloud alias distinct from its local model id.
  await assertOllamaModelContract(
    ['hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M'],
    'hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M',
  );
  await assertOllamaModelContract(['qwen3.5', 'qwen3.5:cloud'], 'qwen3.5:cloud');
}

async function assertOllamaModelContract(
  discoveredModelIds: readonly string[],
  modelId: string,
): Promise<void> {
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = await startJsonServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/api/tags') {
      assert.equal(request.headers.authorization, undefined);
      respondJson(response, 200, {
        models: discoveredModelIds.map((id) => ({ name: id, model: id })),
      });
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, undefined);
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        id: 'chatcmpl-ollama-tool',
        object: 'chat.completion',
        created: 1,
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_echo',
                  type: 'function',
                  function: { name: 'echo', arguments: '{"text":"hello"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      });
      return;
    }
    respondJson(response, 200, {
      id: 'chatcmpl-ollama-final',
      object: 'chat.completion',
      created: 2,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Echoed hello.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
  });
  const connection: LlmConnection = {
    slug: 'ollama-local',
    name: 'Ollama',
    providerType: 'ollama',
    baseUrl: `${server.url}/v1`,
    defaultModel: modelId,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  assert.deepEqual(
    await fetchProviderModels(connection, ''),
    discoveredModelIds.map((id) => ({ id })),
  );

  const result = await generateText({
    model: getAIModel({ connection, apiKey: '', modelId }),
    prompt: 'Call echo with hello, then report the result.',
    tools: {
      echo: tool({
        description: 'Echo text',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => ({ text }),
      }),
    },
    stopWhen: isStepCount(2),
  });

  assert.equal(result.text, 'Echoed hello.');
  assert.equal(requestBodies.length, 2);
  assert.deepEqual(
    requestBodies.map((body) => body.model),
    [modelId, modelId],
  );
  assert.deepEqual(
    (requestBodies[0].tools as Array<{ function: { name: string } }>).map(
      (entry) => entry.function.name,
    ),
    ['echo'],
  );
  const secondMessages = requestBodies[1]?.messages as Array<{ role: string; content: string }>;
  const toolMessage = secondMessages.find((message) => message.role === 'tool');
  assert.ok(toolMessage);
  assert.deepEqual(JSON.parse(toolMessage.content), { text: 'hello' });
}

async function runCohereDiscovery(): Promise<void> {
  const modelId = 'command-a-plus-05-2026';
  const requestBodies: Array<Record<string, unknown>> = [];
  const modelListUrls: string[] = [];
  const server = await startJsonServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer cohere-test-key');
    if (request.method === 'GET' && request.url?.startsWith('/v1/models?')) {
      modelListUrls.push(request.url);
      const url = new URL(request.url, 'http://localhost');
      assert.equal(url.searchParams.get('endpoint'), 'chat');
      assert.equal(url.searchParams.get('page_size'), '1000');
      if (!url.searchParams.has('page_token')) {
        respondJson(response, 200, {
          models: [
            { name: modelId, is_deprecated: false, endpoints: ['chat'], context_length: 128_000 },
            {
              name: 'retired-command',
              is_deprecated: true,
              endpoints: ['chat'],
              context_length: 4_000,
            },
          ],
          next_page_token: 'page-2',
        });
        return;
      }
      assert.equal(url.searchParams.get('page_token'), 'page-2');
      respondJson(response, 200, {
        models: [
          {
            name: 'command-a-reasoning-08-2025',
            is_deprecated: false,
            endpoints: ['chat'],
            context_length: 256_000,
          },
        ],
        next_page_token: '',
      });
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v2/chat');
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        generation_id: 'cohere-tool-turn',
        finish_reason: 'TOOL_CALL',
        message: {
          role: 'assistant',
          content: [],
          tool_plan: 'Call echo.',
          tool_calls: [
            {
              id: 'call_echo',
              type: 'function',
              function: { name: 'echo', arguments: '{"text":"hello"}' },
            },
          ],
        },
        usage: {
          billed_units: { input_tokens: 8, output_tokens: 4 },
          tokens: { input_tokens: 8, output_tokens: 4 },
        },
      });
      return;
    }

    respondJson(response, 200, {
      generation_id: 'cohere-final-turn',
      finish_reason: 'COMPLETE',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Echoed hello.' }],
      },
      usage: {
        billed_units: { input_tokens: 12, output_tokens: 3 },
        tokens: { input_tokens: 12, output_tokens: 3 },
      },
    });
  });
  const connection: LlmConnection = {
    slug: 'cohere',
    name: 'Cohere',
    providerType: 'cohere',
    baseUrl: `${server.url}/v2`,
    defaultModel: modelId,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  const models = await fetchProviderModels(connection, 'cohere-test-key');
  assert.deepEqual(models, [
    { id: modelId, contextWindow: 128_000 },
    { id: 'command-a-reasoning-08-2025', contextWindow: 256_000 },
  ]);
  assert.equal(modelListUrls.length, 2);

  const result = await generateText({
    model: getAIModel({ connection, apiKey: 'cohere-test-key', modelId: models[0]!.id }),
    prompt: 'Call echo with hello.',
    stopWhen: isStepCount(2),
    tools: {
      echo: tool({
        description: 'Echo text',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => ({ echoed: text }),
      }),
    },
  });

  assert.equal(requestBodies.length, 2);
  assert.deepEqual(
    requestBodies.map((body) => body.model),
    [modelId, modelId],
  );
  assert.deepEqual(
    (requestBodies[0].tools as Array<{ function: { name: string } }>).map(
      (entry) => entry.function.name,
    ),
    ['echo'],
  );
  const secondMessages = requestBodies[1]?.messages as Array<Record<string, unknown>>;
  assert.deepEqual(
    secondMessages.find(({ role }) => role === 'assistant'),
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        },
      ],
    },
  );
  assert.deepEqual(
    secondMessages.find(({ role }) => role === 'tool'),
    {
      role: 'tool',
      content: '{"echoed":"hello"}',
      tool_call_id: 'call_echo',
    },
  );
  assert.equal(result.steps[0]?.toolCalls[0]?.toolName, 'echo');
  assert.deepEqual(result.steps[0]?.toolResults[0]?.output, { echoed: 'hello' });
  assert.equal(result.text, 'Echoed hello.');
}

async function runOpenAIResponsesWire(input: {
  providerType: LlmConnection['providerType'];
  slug: string;
  name: string;
  basePath: string;
  modelId: string;
  apiKey: string;
  statelessReasoning?: boolean;
  plaintextReasoning?: boolean;
}): Promise<void> {
  const {
    providerType,
    slug,
    name,
    basePath,
    modelId,
    apiKey,
    statelessReasoning,
    plaintextReasoning,
  } = input;
  const hasReasoning = statelessReasoning || plaintextReasoning;
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = await startJsonServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `${basePath}/responses`);
    assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
    requestBodies.push(JSON.parse(await readBody(request)) as Record<string, unknown>);
    if (requestBodies.length === 1) {
      respondJson(response, 200, {
        id: 'resp_relay_tool',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: modelId,
        output: [
          ...(statelessReasoning
            ? [
                {
                  type: 'reasoning',
                  id: 'rs_relay_tool',
                  summary: [{ type: 'summary_text', text: 'Use echo.' }],
                  encrypted_content: 'encrypted-relay-reasoning',
                },
              ]
            : plaintextReasoning
              ? [
                  {
                    type: 'reasoning',
                    id: 'rs_relay_tool',
                    summary: [],
                    content: [{ type: 'reasoning_text', text: 'Use echo.' }],
                  },
                ]
              : []),
          {
            type: 'function_call',
            id: 'fc_relay_echo',
            call_id: 'call_relay_echo',
            name: 'echo',
            arguments: '{"text":"hello"}',
            status: 'completed',
          },
        ],
        usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
      });
      return;
    }
    respondJson(response, 200, {
      id: 'resp_relay_final',
      object: 'response',
      created_at: 2,
      status: 'completed',
      model: modelId,
      output: [
        {
          type: 'message',
          id: 'msg_relay_final',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Echoed hello.', annotations: [], logprobs: [] }],
        },
      ],
      usage: { input_tokens: 14, output_tokens: 3, total_tokens: 17 },
    });
  });
  const connection: LlmConnection = {
    slug,
    name,
    providerType,
    baseUrl: `${server.url}${basePath}`,
    defaultModel: modelId,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  const result = await generateText({
    model: getAIModel({ connection, apiKey, modelId }),
    prompt: 'Call echo with hello.',
    ...(hasReasoning ? { providerOptions: buildProviderOptions(connection, modelId) } : {}),
    stopWhen: isStepCount(2),
    tools: {
      echo: tool({
        description: 'Echo text',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => ({ echoed: text }),
      }),
    },
  });

  assert.deepEqual(
    requestBodies.map((body) => body.model),
    [modelId, modelId],
  );
  if (statelessReasoning) {
    assert.equal(requestBodies[0]?.store, false);
    assert.deepEqual(requestBodies[0]?.include, ['reasoning.encrypted_content']);
    assert.deepEqual(
      (requestBodies[1].input as Array<Record<string, unknown>>).find(
        ({ type }) => type === 'reasoning',
      ),
      {
        type: 'reasoning',
        id: 'rs_relay_tool',
        summary: [{ type: 'summary_text', text: 'Use echo.' }],
        encrypted_content: 'encrypted-relay-reasoning',
      },
    );
  }
  if (plaintextReasoning) {
    assert.deepEqual(
      (requestBodies[1].input as Array<Record<string, unknown>>).find(
        ({ type }) => type === 'reasoning',
      ),
      {
        type: 'reasoning',
        id: 'rs_relay_tool',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'Use echo.' }],
      },
    );
  }
  assert.deepEqual(
    (requestBodies[1].input as Array<Record<string, unknown>>).find(
      ({ type }) => type === 'function_call_output',
    ),
    {
      type: 'function_call_output',
      call_id: 'call_relay_echo',
      output: '{"echoed":"hello"}',
    },
  );
  assert.equal(result.text, 'Echoed hello.');
}

async function runZenMuxSignedReasoningReplay(): Promise<void> {
  const modelId = 'moonshotai/kimi-k2.5';
  const reasoningDetails = [
    {
      type: 'reasoning.text',
      text: 'Use echo.',
      signature: 'deterministic-stream-signature',
      format: 'anthropic-claude-v1',
    },
  ];
  const requestBodies: Array<Record<string, unknown>> = [];
  const server = await startJsonServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requestBodies.push(body);
    assert.equal(body.stream, true);
    if (requestBodies.length === 1) {
      respondOpenAIStream(response, [
        {
          id: 'chatcmpl-zenmux-stream-tool',
          object: 'chat.completion.chunk',
          created: 1,
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                reasoning: 'Use echo.',
                reasoning_details: reasoningDetails,
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_zenmux_stream_echo',
                    type: 'function',
                    function: { name: 'echo', arguments: '{"text":"hello"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chatcmpl-zenmux-stream-tool',
          object: 'chat.completion.chunk',
          created: 1,
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        },
      ]);
      return;
    }
    respondOpenAIStream(response, [
      {
        id: 'chatcmpl-zenmux-stream-final',
        object: 'chat.completion.chunk',
        created: 2,
        model: modelId,
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'Echoed hello.' }, finish_reason: null },
        ],
      },
      {
        id: 'chatcmpl-zenmux-stream-final',
        object: 'chat.completion.chunk',
        created: 2,
        model: modelId,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 14, completion_tokens: 3, total_tokens: 17 },
      },
    ]);
  });
  const connection: LlmConnection = {
    slug: 'zenmux',
    name: 'ZenMux',
    providerType: 'zenmux',
    baseUrl: `${server.url}/v1`,
    defaultModel: modelId,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  const result = streamText({
    model: getAIModel({ connection, apiKey: 'zenmux-test-key', modelId }),
    prompt: 'Call echo with hello.',
    stopWhen: isStepCount(2),
    tools: {
      echo: tool({
        description: 'Echo text',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => ({ echoed: text }),
      }),
    },
  });

  assert.equal(await result.text, 'Echoed hello.');
  assert.equal(requestBodies.length, 2);
  assert.deepEqual(
    (requestBodies[1].messages as Array<Record<string, unknown>>).find(
      ({ role }) => role === 'assistant',
    ),
    {
      role: 'assistant',
      content: null,
      reasoning: 'Use echo.',
      reasoning_details: reasoningDetails,
      tool_calls: [
        {
          id: 'call_zenmux_stream_echo',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hello"}' },
        },
      ],
    },
  );
}
