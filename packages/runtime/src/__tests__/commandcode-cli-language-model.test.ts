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

import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import {
  APICallError,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  buildCommandCodeCliRequest,
  COMMANDCODE_CLI_VERSION,
  CommandCodeCliLanguageModel,
  commandCodeCliHeaders,
  mapFinishReason,
  projectSlugFromPath,
  toolParametersSchema,
  wireToolCallIds,
} from '../commandcode-cli-language-model.js';
import { getAIModel } from '../model-factory.js';
import { resolveModelRuntime } from '../model-runtime.js';
import { classifyError } from '../provider-error-classification.js';
import { testConnection } from '../test-connection.js';
import {
  closeAllJsonServers,
  readBody,
  respondJson,
  startJsonServer,
} from './conformance-harness.js';

after(closeAllJsonServers);

function respondCliStream(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function collect(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const parts: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

const USER_HI: LanguageModelV4CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

describe('request building', () => {
  test('sends the official CLI identity headers and derives the project slug', () => {
    const headers = commandCodeCliHeaders('user_k', '/Users/me/My Repo');
    assert.equal(headers.authorization, 'Bearer user_k');
    assert.equal(headers['x-command-code-version'], COMMANDCODE_CLI_VERSION);
    assert.equal(headers['x-cli-environment'], 'production');
    assert.equal(headers['x-project-slug'], 'users-me-my-repo');
    assert.equal(projectSlugFromPath('C:\\Work\\proj'), 'work-proj');
    assert.equal(projectSlugFromPath('///'), 'project');
  });

  test('folds system messages, replays paired tool calls with reasoning, aliases overlong ids', () => {
    const longId = `call-${'x'.repeat(80)}`;
    const { body, warnings } = buildCommandCodeCliRequest(
      {
        prompt: [
          { role: 'system', content: 'Be terse.' },
          { role: 'system', content: 'Answer in English.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'read it' },
              {
                type: 'file',
                mediaType: 'image/png',
                data: { type: 'data', data: new Uint8Array([1, 2, 3]) },
              },
              { type: 'file', mediaType: 'application/pdf', data: { type: 'data', data: 'AAAA' } },
              {
                type: 'file',
                mediaType: 'image/jpeg',
                data: { type: 'url', url: new URL('https://example.invalid/a.jpg') },
              },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'I should read the file.' },
              { type: 'tool-call', toolCallId: longId, toolName: 'read', input: { path: 'a.txt' } },
              { type: 'tool-call', toolCallId: 'orphan', toolName: 'read', input: {} },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: longId,
                toolName: 'read',
                output: { type: 'json', value: { ok: true } },
              },
            ],
          },
        ],
        tools: [
          {
            type: 'function',
            name: 'read',
            description: 'Read a file',
            inputSchema: { type: ['object', 'null'], properties: { path: { type: 'string' } } },
          },
        ],
        maxOutputTokens: 1_000,
        temperature: 0,
        topP: 0.5,
        toolChoice: { type: 'required' },
        reasoning: 'high',
      },
      { modelId: 'deepseek/deepseek-v4.1-flash', workingDir: '/tmp/x', threadId: () => 'thread-1' },
    );
    const params = body.params as Record<string, unknown>;
    assert.equal(params.model, 'deepseek/deepseek-v4.1-flash');
    assert.equal(params.system, 'Be terse.\n\nAnswer in English.');
    assert.equal(params.max_tokens, 1_000);
    assert.equal(params.temperature, 0);
    assert.equal(params.stream, true);
    assert.equal(params.reasoning_effort, 'high');
    assert.equal(body.threadId, 'thread-1');
    assert.deepEqual(params.tools, [
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
    assert.deepEqual(params.messages, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'read it' },
          { type: 'image', image: 'data:image/png;base64,AQID', mimeType: 'image/png' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'I should read the file.' },
          { type: 'tool-call', toolCallId: 'cc-1', toolName: 'read', input: { path: 'a.txt' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'cc-1',
            toolName: 'read',
            output: { type: 'text', value: '{"ok":true}' },
          },
        ],
      },
    ]);
    assert.deepEqual(warnings.map((w) => (w.type === 'unsupported' ? w.feature : w.type)).sort(), [
      'file input application/pdf',
      'image url input',
      'toolChoice',
      'topP',
    ]);
  });

  test('reasoning effort: provider options win, provider-default and none are omitted', () => {
    const build = (options: Partial<LanguageModelV4CallOptions>) =>
      (
        buildCommandCodeCliRequest({ ...USER_HI, ...options }, { modelId: 'm' }).body
          .params as Record<string, unknown>
      ).reasoning_effort;
    assert.equal(build({}), undefined);
    assert.equal(build({ reasoning: 'provider-default' }), undefined);
    assert.equal(build({ reasoning: 'none' }), undefined);
    assert.equal(build({ reasoning: 'low' }), 'low');
    assert.equal(
      build({
        reasoning: 'low',
        providerOptions: { 'commandcode-cli': { reasoningEffort: 'xhigh' } },
      }),
      'xhigh',
    );
  });

  test('tool schemas are normalized to a root object type', () => {
    assert.deepEqual(toolParametersSchema(undefined), {
      type: 'object',
      properties: {},
      additionalProperties: true,
    });
    assert.deepEqual(toolParametersSchema({ properties: { a: { type: 'string' } } }), {
      properties: { a: { type: 'string' } },
      type: 'object',
    });
    assert.deepEqual(
      toolParametersSchema({
        $ref: '#/$defs/Args',
        $defs: { Args: { type: 'object', properties: { a: {} } } },
      }),
      {
        type: 'object',
        properties: { a: {} },
        $defs: { Args: { type: 'object', properties: { a: {} } } },
      },
    );
    assert.deepEqual(
      toolParametersSchema({
        anyOf: [
          { type: 'object', properties: { a: {} }, required: ['a'] },
          { type: 'object', properties: { b: {} } },
        ],
      }),
      { type: 'object', properties: { a: {}, b: {} }, required: ['a'], additionalProperties: true },
    );
  });

  test('wire ids pass short ids through and alias the rest without collisions', () => {
    const long = 'l'.repeat(65);
    const wire = wireToolCallIds(new Set(['cc-1', long, 'short']));
    assert.equal(wire.get('cc-1'), 'cc-1');
    assert.equal(wire.get('short'), 'short');
    assert.equal(wire.get(long), 'cc-2');
  });

  test('finish reasons map onto the unified vocabulary', () => {
    assert.deepEqual(mapFinishReason('tool-calls'), { unified: 'tool-calls', raw: 'tool-calls' });
    assert.deepEqual(mapFinishReason('max_tokens'), { unified: 'length', raw: 'max_tokens' });
    assert.deepEqual(mapFinishReason('stop'), { unified: 'stop', raw: 'stop' });
    assert.deepEqual(mapFinishReason(undefined), { unified: 'stop', raw: undefined });
  });
});

describe('streaming against a CLI-shaped server', () => {
  test('maps reasoning, text, a tool call, and usage onto AI SDK stream parts', async () => {
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    let seenBody: Record<string, unknown> = {};
    const server = await startJsonServer(async (request, response) => {
      assert.equal(request.url, '/alpha/generate');
      seenHeaders = request.headers;
      seenBody = JSON.parse(await readBody(request)) as Record<string, unknown>;
      respondCliStream(response, [
        { type: 'reasoning-start' },
        { type: 'reasoning-delta', text: 'think ' },
        { type: 'reasoning-delta', text: 'hard' },
        { type: 'reasoning-end' },
        { type: 'text-delta', text: 'Hel' },
        { type: 'text-delta', text: 'lo' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'echo', input: { text: 'hi' } },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          totalUsage: {
            inputTokens: 100,
            outputTokens: 7,
            inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 10 },
            outputTokenDetails: { reasoningTokens: 3 },
          },
        },
      ]);
    });
    const model = new CommandCodeCliLanguageModel({
      modelId: 'deepseek/deepseek-v4.1-flash',
      apiKey: 'user_k',
      apiBase: server.url,
      workingDir: '/repo',
    });
    const { stream, request } = await model.doStream(USER_HI);
    const parts = await collect(stream);
    assert.equal(seenHeaders['x-command-code-version'], COMMANDCODE_CLI_VERSION);
    assert.equal(seenHeaders['x-project-slug'], 'repo');
    assert.equal(seenHeaders.authorization, 'Bearer user_k');
    assert.equal(
      (seenBody.params as Record<string, unknown>).model,
      'deepseek/deepseek-v4.1-flash',
    );
    assert.deepEqual(request?.body, seenBody);
    assert.deepEqual(
      parts.map((p) => p.type),
      [
        'stream-start',
        'response-metadata',
        'reasoning-start',
        'reasoning-delta',
        'reasoning-delta',
        'reasoning-end',
        'text-start',
        'text-delta',
        'text-delta',
        'text-end',
        'tool-input-start',
        'tool-input-delta',
        'tool-input-end',
        'tool-call',
        'finish',
      ],
    );
    const toolCall = parts.find((p) => p.type === 'tool-call');
    assert.deepEqual(toolCall, {
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'echo',
      input: '{"text":"hi"}',
    });
    const finish = parts.at(-1);
    assert.equal(finish?.type, 'finish');
    if (finish?.type !== 'finish') return;
    assert.deepEqual(finish.finishReason, { unified: 'tool-calls', raw: 'tool-calls' });
    assert.deepEqual(
      { ...finish.usage, raw: undefined },
      {
        inputTokens: { total: 100, noCache: 50, cacheRead: 40, cacheWrite: 10 },
        outputTokens: { total: 7, text: undefined, reasoning: 3 },
        raw: undefined,
      },
    );
  });

  test('doGenerate assembles the streamed blocks into content', async () => {
    const server = await startJsonServer((_request, response) => {
      respondCliStream(response, [
        { type: 'reasoning-delta', text: 'r' },
        { type: 'text-delta', text: 'pong' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 3, outputTokens: 1 } },
      ]);
    });
    const model = new CommandCodeCliLanguageModel({
      modelId: 'm',
      apiKey: 'k',
      apiBase: server.url,
    });
    const result = await model.doGenerate(USER_HI);
    assert.deepEqual(result.content, [
      { type: 'reasoning', text: 'r' },
      { type: 'text', text: 'pong' },
    ]);
    assert.deepEqual(result.finishReason, { unified: 'stop', raw: 'stop' });
    assert.equal(result.usage.inputTokens.total, 3);
  });

  test('a 403 upgrade_required rejection is a plan (billing) failure, not a bad key', async () => {
    const server = await startJsonServer((_request, response) => {
      respondJson(response, 403, {
        error: {
          code: 'upgrade_required',
          message: "Your Go plan doesn't include API access. Upgrade to Provider or higher.",
        },
      });
    });
    const model = new CommandCodeCliLanguageModel({
      modelId: 'm',
      apiKey: 'k',
      apiBase: server.url,
    });
    await assert.rejects(model.doStream(USER_HI), (error: unknown) => {
      assert.ok(APICallError.isInstance(error));
      assert.equal(error.statusCode, 403);
      assert.equal(error.isRetryable, false);
      assert.equal(classifyError(error), 'provider_billing');
      return true;
    });
  });

  test('an in-band error event surfaces as an error part carrying its status', async () => {
    const server = await startJsonServer((_request, response) => {
      respondCliStream(response, [
        { type: 'text-delta', text: 'partial' },
        {
          type: 'error',
          error: { message: 'insufficient credits', statusCode: 402, code: 'credits' },
        },
      ]);
    });
    const model = new CommandCodeCliLanguageModel({
      modelId: 'm',
      apiKey: 'k',
      apiBase: server.url,
    });
    const parts = await collect((await model.doStream(USER_HI)).stream);
    const errorPart = parts.find((p) => p.type === 'error');
    assert.ok(errorPart && errorPart.type === 'error');
    assert.ok(APICallError.isInstance(errorPart.error));
    assert.equal(errorPart.error.statusCode, 402);
    assert.equal(classifyError(errorPart.error), 'provider_billing');
    assert.equal(parts.filter((p) => p.type === 'finish').length, 0);
  });

  test('a stream that ends without finish reports a retryable truncation', async () => {
    const server = await startJsonServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'text-delta', text: 'cut' })}\n\n`);
    });
    const model = new CommandCodeCliLanguageModel({
      modelId: 'm',
      apiKey: 'k',
      apiBase: server.url,
    });
    const parts = await collect((await model.doStream(USER_HI)).stream);
    const last = parts.at(-1);
    assert.ok(last && last.type === 'error' && APICallError.isInstance(last.error));
    assert.equal(last.error.isRetryable, true);
  });
});

describe('runtime wiring', () => {
  const connection: LlmConnection = {
    slug: 'cc-go',
    name: 'Command Code GO',
    providerType: 'commandcode-go',
    defaultModel: 'deepseek/deepseek-v4.1-flash',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  test('resolves to the CLI wire with reasoning replayed as reasoning blocks', () => {
    const runtime = resolveModelRuntime(connection, 'deepseek/deepseek-v4.1-flash');
    assert.equal(runtime.wire, 'commandcode-cli');
    assert.equal(runtime.adapter.kind, 'commandcode-cli');
    assert.deepEqual(runtime.reasoningReplay, {
      kind: 'openai-chat-plaintext',
      requestField: 'reasoning',
    });
    assert.equal(runtime.baseUrl, 'https://api.commandcode.ai');
  });

  // Choosing this provider is the choice to use this wire: nothing else routes
  // here, and no other provider falls back to it.
  test('a Command Code GO connection builds the CLI transport', () => {
    const model = getAIModel({ connection, apiKey: 'k', modelId: 'deepseek/deepseek-v4.1-flash' });
    assert.ok(model instanceof CommandCodeCliLanguageModel);
  });

  test('an already encoded data URL is not wrapped a second time', () => {
    const { body } = buildCommandCodeCliRequest(
      {
        prompt: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType: 'image/png',
                data: { type: 'data', data: 'data:image/png;base64,AQID' },
              },
            ],
          },
        ],
      },
      { modelId: 'm' },
    );
    const [message] = body.params.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(message?.content[0], {
      type: 'image',
      image: 'data:image/png;base64,AQID',
      mimeType: 'image/png',
    });
  });

  test('the connection test posts one tiny CLI generate and reads the status', async () => {
    const urls: string[] = [];
    const server = await startJsonServer(async (request, response) => {
      urls.push(String(request.url));
      const body = JSON.parse(await readBody(request)) as { params: Record<string, unknown> };
      assert.equal(body.params.max_tokens, 16);
      assert.equal(request.headers['x-command-code-version'], COMMANDCODE_CLI_VERSION);
      respondCliStream(response, [{ type: 'finish', finishReason: 'stop' }]);
    });
    const result = await testConnection(
      { ...connection, baseUrl: server.url },
      'k',
      'deepseek/deepseek-v4.1-flash',
      { fetch },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(urls, ['/alpha/generate']);
  });

  test('the connection test fails on an in-band error behind HTTP 200', async () => {
    const server = await startJsonServer((_request, response) => {
      respondCliStream(response, [
        {
          type: 'error',
          error: { message: 'bad key', statusCode: 401, code: 'invalid_key' },
        },
      ]);
    });
    const result = await testConnection(
      { ...connection, baseUrl: server.url },
      'k',
      'deepseek/deepseek-v4.1-flash',
      { fetch },
    );
    assert.equal(result.ok, false, 'HTTP 200 is only the handshake on this wire');
    assert.equal(result.statusCode, 401);
    assert.equal(result.errorClass, 'auth');
    assert.match(result.errorMessage ?? '', /bad key/u);
  });

  test('the connection test fails when the stream never reaches finish', async () => {
    const server = await startJsonServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'text-delta', text: 'cut' })}\n\n`);
    });
    const result = await testConnection(
      { ...connection, baseUrl: server.url },
      'k',
      'deepseek/deepseek-v4.1-flash',
      { fetch },
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, 'network');
  });

  test('a rate-limited stream error reports the provider, not the credential', async () => {
    const server = await startJsonServer((_request, response) => {
      respondCliStream(response, [
        { type: 'error', error: { message: 'slow down', statusCode: 429 } },
      ]);
    });
    const result = await testConnection(
      { ...connection, baseUrl: server.url },
      'k',
      'deepseek/deepseek-v4.1-flash',
      { fetch },
    );
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, 'provider_unavailable');
  });
});
