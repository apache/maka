/**
 * opencode-free anonymous runtime — the invariant the free tier depends on.
 *
 * opencode-free is Maka's zero-credential default. Its free-tier access works
 * ONLY because the request carries no Authorization header and the OpenCode
 * Zen server treats that as anonymous (per-IP rate-limited). This invariant is
 * the whole point of the provider, so it must be locked directly against
 * opencode-free, not inferred from "the code path looks like Ollama's".
 *
 * If @ai-sdk/openai-compatible ever stops omitting the header on an empty key,
 * or someone later "improves" opencode-free by injecting a placeholder key,
 * this test must fail before the anonymous free path silently breaks.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { generateText } from 'ai';
import type { LlmConnection } from '@maka/core/llm-connections';
import { getAIModel } from '@maka/runtime/model-factory';

import { testConnection } from '@maka/runtime/test-connection';

describe('opencode-free anonymous runtime', () => {
  test('omits Authorization and posts to zen/v1 with the model id (empty key, no secret)', async () => {
    const baseUrl = 'https://opencode.ai/zen/v1';
    const connection: LlmConnection = {
      slug: 'opencode-free',
      name: 'OpenCode Free',
      providerType: 'opencode-free',
      baseUrl,
      defaultModel: 'big-pickle',
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };

    let captured: { url: string; authorization: string | null; model: unknown } | undefined;
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      captured = {
        url: request.url,
        authorization: request.headers.get('authorization'),
        model: body.model,
      };
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-opencode-free',
          object: 'chat.completion',
          created: 1,
          model: 'big-pickle',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const model = getAIModel({
      connection,
      apiKey: '',
      modelId: 'big-pickle',
      fetch: fakeFetch,
    });

    const result = await generateText({ model, prompt: 'hi' });

    assert.ok(captured, 'opencode-free request was issued');
    assert.equal(
      captured?.authorization,
      null,
      'opencode-free must send NO Authorization header (anonymous free tier)',
    );
    assert.equal(captured?.url, 'https://opencode.ai/zen/v1/chat/completions');
    assert.equal(captured?.model, 'big-pickle');
    assert.equal(result.text, 'ok');
  });

  test('rejects a 200 error envelope and probes the next free model', async () => {
    const requestedModels: string[] = [];
    const connection: LlmConnection = {
      slug: 'opencode-free',
      name: 'OpenCode Free',
      providerType: 'opencode-free',
      defaultModel: 'big-pickle',
      enabledModelIds: ['big-pickle'],
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      if (body.model === 'big-pickle') {
        return new Response(JSON.stringify({ error: { type: 'server_error' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await testConnection(connection, '', undefined, { fetch: fakeFetch });

    assert.equal(result.ok, true);
    assert.equal(result.modelTested, 'nemotron-3-ultra-free');
    assert.deepEqual(requestedModels, ['big-pickle', 'nemotron-3-ultra-free']);
  });

  test('probes a healthy fallback for a customized connection without hiding the model tested', async () => {
    const requestedModels: string[] = [];
    const connection: LlmConnection = {
      slug: 'my-opencode-free',
      name: 'My free connection',
      providerType: 'opencode-free',
      baseUrl: 'https://custom.example/v1',
      defaultModel: 'custom-broken-free',
      enabledModelIds: ['custom-broken-free'],
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      return new Response(
        JSON.stringify(
          body.model === 'custom-broken-free'
            ? { error: { type: 'server_error' } }
            : { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await testConnection(connection, '', undefined, { fetch: fakeFetch });

    assert.equal(result.ok, true);
    assert.equal(result.modelTested, 'nemotron-3-ultra-free');
    assert.deepEqual(requestedModels, ['custom-broken-free', 'nemotron-3-ultra-free']);
  });

  test('tests an explicit model once without probing fallbacks', async () => {
    const requestedModels: string[] = [];
    const connection: LlmConnection = {
      slug: 'opencode-free',
      name: 'OpenCode Free',
      providerType: 'opencode-free',
      defaultModel: 'nemotron-3-ultra-free',
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      return new Response(JSON.stringify({ error: { type: 'server_error' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await testConnection(connection, '', 'explicit-free', { fetch: fakeFetch });

    assert.equal(result.ok, false);
    assert.equal(result.modelTested, 'explicit-free');
    assert.deepEqual(requestedModels, ['explicit-free']);
  });

  test('rejects malformed completion choices before accepting a fallback', async () => {
    const requestedModels: string[] = [];
    const connection: LlmConnection = {
      slug: 'opencode-free',
      name: 'OpenCode Free',
      providerType: 'opencode-free',
      defaultModel: 'big-pickle',
      enabledModelIds: ['big-pickle'],
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      return new Response(
        JSON.stringify(
          body.model === 'big-pickle'
            ? { choices: [{}] }
            : { choices: [{ message: { role: 'assistant', content: 'ok' } }] },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await testConnection(connection, '', undefined, { fetch: fakeFetch });

    assert.equal(result.ok, true);
    assert.equal(result.modelTested, 'nemotron-3-ultra-free');
    assert.deepEqual(requestedModels, ['big-pickle', 'nemotron-3-ultra-free']);
  });

  test('accepts a reasoning completion whose final content is null', async () => {
    const connection: LlmConnection = {
      slug: 'opencode-free',
      name: 'OpenCode Free',
      providerType: 'opencode-free',
      defaultModel: 'mimo-v2.5-free',
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                reasoning_content: 'The answer was truncated before final text.',
              },
              finish_reason: 'length',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const result = await testConnection(connection, '', 'mimo-v2.5-free', { fetch: fakeFetch });

    assert.equal(result.ok, true);
    assert.equal(result.modelTested, 'mimo-v2.5-free');
  });

  test('bounds all fallback probes by one shared deadline', async () => {
    const connection: LlmConnection = {
      slug: 'opencode-free',
      name: 'OpenCode Free',
      providerType: 'opencode-free',
      defaultModel: 'big-pickle',
      enabledModelIds: ['big-pickle'],
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        const rejectFromAbort = () => reject(signal.reason);
        if (signal.aborted) rejectFromAbort();
        else signal.addEventListener('abort', rejectFromAbort, { once: true });
      });
    };
    const startedAt = Date.now();

    const result = await testConnection(connection, '', undefined, {
      fetch: fakeFetch,
      timeoutMs: 40,
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorClass, 'timeout');
    assert.ok(Date.now() - startedAt < 1_000);
  });
});
