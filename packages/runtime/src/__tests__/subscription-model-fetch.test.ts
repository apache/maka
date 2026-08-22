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
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import { buildSubscriptionModelFetch } from '../subscription-model-fetch.js';

describe('subscription model fetch', () => {
  test('maps Codex OAuth requests into the ChatGPT backend request shape', async () => {
    let observedHeaders = new Headers();
    let observedBody = '';
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.5',
      fetchFn: async (_url, init) => {
        observedHeaders = new Headers(init?.headers);
        observedBody = String(init?.body ?? '');
        return Response.json({ ok: true });
      },
    });

    assert.ok(modelFetch);
    await modelFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer token' },
      body: JSON.stringify({
        system: 'Use the Maka system prompt.',
        input: [{ role: 'user', content: 'hi' }],
      }),
    });

    const body = JSON.parse(observedBody);
    assert.equal(observedHeaders.get('originator'), 'codex_cli_rs');
    assert.equal(observedHeaders.get('session_id'), 'session-123');
    assert.equal(observedHeaders.get('x-client-request-id'), 'session-123');
    assert.equal(body.instructions, 'Use the Maka system prompt.');
    assert.equal(body.store, false);
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(body.text.verbosity, 'medium');
  });

  test('force-refreshes one Codex 401 without consuming the independent edge retry budget', async () => {
    const observed: Headers[] = [];
    let attempts = 0;
    let refreshes = 0;
    const refreshedToken = codexToken('account-refreshed');
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-401',
      modelId: 'gpt-5.6-sol',
      fetchFn: async (_url, init) => {
        attempts += 1;
        observed.push(new Headers(init?.headers));
        if (attempts === 1) {
          return Response.json({ error: { message: 'token invalidated' } }, { status: 401 });
        }
        if (attempts <= 4) {
          return new Response('<!doctype html><title>Request rejected</title>', {
            status: 403,
            headers: { 'retry-after': '0' },
          });
        }
        return Response.json({ ok: true });
      },
      refreshOAuthAccessToken: async () => {
        refreshes += 1;
        return refreshedToken;
      },
    });

    assert.ok(modelFetch);
    const response = await modelFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${codexToken('account-stale')}`,
        'ChatGPT-Account-Id': 'account-stale',
      },
      body: JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
    });

    assert.equal(response.ok, true);
    assert.equal(attempts, 5);
    assert.equal(refreshes, 1);
    assert.equal(observed[1]?.get('authorization'), `Bearer ${refreshedToken}`);
    assert.equal(observed[1]?.get('ChatGPT-Account-Id'), 'account-refreshed');
  });

  test('does not replay a Codex 401 when forced refresh fails', async () => {
    let attempts = 0;
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-401',
      modelId: 'gpt-5.6-sol',
      fetchFn: async () => {
        attempts += 1;
        return Response.json({ error: 'invalid token' }, { status: 401 });
      },
      refreshOAuthAccessToken: async () => null,
    });
    assert.ok(modelFetch);
    await assert.rejects(
      modelFetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        body: JSON.stringify({ input: [] }),
      }),
      /HTTP 401/,
    );
    assert.equal(attempts, 1);
  });

  test('retries a transient HTML 403 from the Codex edge', async () => {
    let attempts = 0;
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response('<!doctype html><title>Request rejected</title>', {
            status: 403,
            headers: { 'retry-after': '0' },
          });
        }
        return Response.json({ ok: true });
      },
    });

    assert.ok(modelFetch);
    const response = await modelFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
    });

    assert.equal(response.ok, true);
    assert.equal(attempts, 2);
  });

  test('does not retry a JSON 403 from the Codex API', async () => {
    let attempts = 0;
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async () => {
        attempts += 1;
        return Response.json(
          { error: { message: 'account is not authorized', code: 'account_not_authorized' } },
          { status: 403, headers: { 'x-request-id': 'req-codex-403' } },
        );
      },
    });

    assert.ok(modelFetch);
    await assert.rejects(
      modelFetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        body: JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Codex OAuth request failed: HTTP 403/);
        assert.equal((error as { statusCode?: unknown }).statusCode, 403);
        assert.deepEqual((error as { data?: unknown }).data, {
          error: { code: 'account_not_authorized' },
        });
        assert.deepEqual((error as { responseHeaders?: unknown }).responseHeaders, {
          'x-request-id': 'req-codex-403',
        });
        return true;
      },
    );
    assert.equal(attempts, 1);
  });

  test('aborts while waiting to retry an HTML 403', async () => {
    let attempts = 0;
    const controller = new AbortController();
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async () => {
        attempts += 1;
        controller.abort();
        return new Response('<html><title>Request rejected</title>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        });
      },
    });

    assert.ok(modelFetch);
    await assert.rejects(
      modelFetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        body: JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
        signal: controller.signal,
      }),
      /abort/i,
    );
    assert.equal(attempts, 1);
  });

  test('aborts a retry delay through a Request signal', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    const controller = new AbortController();
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async () => {
        attempts += 1;
        return new Response('<html><title>Request rejected</title>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        });
      },
    });

    assert.ok(modelFetch);
    const request = new Request('https://chatgpt.com/backend-api/codex/responses', {
      signal: controller.signal,
    });
    const outcome = modelFetch(request).then(
      () => 'resolved',
      (error: unknown) => String(error),
    );
    await eventLoopTurn();
    controller.abort();

    const result = await Promise.race([outcome, eventLoopTurn().then(() => 'pending')]);
    assert.match(result, /abort/i);
    assert.equal(attempts, 1);
  });

  test('prefers an init signal over a Request signal', async () => {
    let attempts = 0;
    const requestController = new AbortController();
    const initController = new AbortController();
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) {
          requestController.abort();
          return new Response('<html><title>Request rejected</title>', {
            status: 403,
            headers: { 'content-type': 'text/html', 'retry-after': '0' },
          });
        }
        return Response.json({ ok: true });
      },
    });

    assert.ok(modelFetch);
    const request = new Request('https://chatgpt.com/backend-api/codex/responses', {
      signal: requestController.signal,
    });
    const response = await modelFetch(request, { signal: initController.signal });

    assert.equal(response.ok, true);
    assert.equal(attempts, 2);
  });

  test('does not inherit a Request signal when init explicitly sets signal to null', async () => {
    let attempts = 0;
    const controller = new AbortController();
    controller.abort();
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response('<html><title>Request rejected</title>', {
            status: 403,
            headers: { 'content-type': 'text/html', 'retry-after': '0' },
          });
        }
        return Response.json({ ok: true });
      },
    });

    assert.ok(modelFetch);
    const request = new Request('https://chatgpt.com/backend-api/codex/responses', {
      signal: controller.signal,
    });
    const response = await modelFetch(request, { signal: null });

    assert.equal(response.ok, true);
    assert.equal(attempts, 2);
  });

  test('caps HTML 403 retries after fallback delays of 2, 10, and 30 seconds', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async () => {
        attempts += 1;
        return new Response('<html><title>Request rejected</title>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        });
      },
    });

    assert.ok(modelFetch);
    const rejection = assert.rejects(
      modelFetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        body: JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
      }),
      /Codex OAuth request failed: HTTP 403/,
    );

    await eventLoopTurn();
    assert.equal(attempts, 1);
    t.mock.timers.tick(1_999);
    await eventLoopTurn();
    assert.equal(attempts, 1);
    t.mock.timers.tick(1);
    await eventLoopTurn();
    assert.equal(attempts, 2);
    t.mock.timers.tick(9_999);
    await eventLoopTurn();
    assert.equal(attempts, 2);
    t.mock.timers.tick(1);
    await eventLoopTurn();
    assert.equal(attempts, 3);
    t.mock.timers.tick(29_999);
    await eventLoopTurn();
    assert.equal(attempts, 3);
    t.mock.timers.tick(1);
    await rejection;
    assert.equal(attempts, 4);
  });

  test('caps a numeric Retry-After delay at 30 seconds', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response('<html><title>Request rejected</title>', {
            status: 403,
            headers: { 'content-type': 'text/html', 'retry-after': '60' },
          });
        }
        return Response.json({ ok: true });
      },
    });

    assert.ok(modelFetch);
    const response = modelFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
    });

    await eventLoopTurn();
    t.mock.timers.tick(29_999);
    await eventLoopTurn();
    assert.equal(attempts, 1);
    t.mock.timers.tick(1);
    await eventLoopTurn();
    assert.equal(attempts, 2);
    assert.equal((await response).ok, true);
  });

  test('adds the Copilot compatibility headers and derives the turn initiator without rewriting the body', async () => {
    const observed: Array<{ headers: Headers; body: string }> = [];
    const modelFetch = buildSubscriptionModelFetch({
      connection: githubCopilotConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.4',
      fetchFn: async (_url, init) => {
        observed.push({ headers: new Headers(init?.headers), body: String(init?.body ?? '') });
        return Response.json({ ok: true });
      },
    });

    assert.ok(modelFetch);
    const userBody = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });
    await modelFetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer short-lived-token' },
      body: userBody,
    });
    const toolBody = JSON.stringify({
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call-1' }] },
        { role: 'tool', tool_call_id: 'call-1', content: 'done' },
      ],
    });
    await modelFetch('https://api.githubcopilot.com/chat/completions', {
      method: 'POST',
      body: toolBody,
    });
    const responsesBody = JSON.stringify({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image' }] },
      ],
    });
    await modelFetch('https://api.githubcopilot.com/responses', {
      method: 'POST',
      body: responsesBody,
    });

    assert.equal(observed[0]?.headers.get('user-agent'), 'GitHubCopilotChat/0.35.0');
    assert.equal(observed[0]?.headers.get('editor-version'), 'vscode/1.107.0');
    assert.equal(observed[0]?.headers.get('editor-plugin-version'), 'copilot-chat/0.35.0');
    assert.equal(observed[0]?.headers.get('copilot-integration-id'), 'vscode-chat');
    assert.equal(observed[0]?.headers.get('openai-intent'), 'conversation-edits');
    assert.equal(observed[0]?.headers.get('x-initiator'), 'user');
    assert.equal(observed[0]?.body, userBody);
    assert.equal(observed[1]?.headers.get('x-initiator'), 'agent');
    assert.equal(observed[1]?.body, toolBody);
    assert.equal(observed[2]?.headers.get('x-initiator'), 'user');
    assert.equal(observed[2]?.headers.get('copilot-vision-request'), 'true');
    assert.equal(observed[2]?.body, responsesBody);
  });

  test('force-refreshes and replays one xAI OAuth request on 401', async () => {
    const observed: Headers[] = [];
    const modelFetch = buildSubscriptionModelFetch({
      connection: xaiOAuthConnection(),
      sessionId: 'xai-session',
      modelId: 'grok-4.5',
      fetchFn: async (_url, init) => {
        observed.push(new Headers(init?.headers));
        return observed.length === 1
          ? Response.json({ error: 'invalid token' }, { status: 401 })
          : Response.json({ ok: true });
      },
      refreshOAuthAccessToken: async () => 'xai-access-refreshed',
    });
    assert.ok(modelFetch);
    const response = await modelFetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer xai-access-stale' },
      body: JSON.stringify({ input: [] }),
    });
    assert.equal(response.ok, true);
    assert.equal(observed.length, 2);
    assert.equal(observed[1]?.get('authorization'), 'Bearer xai-access-refreshed');
  });
});

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function openAiCodexConnection(): LlmConnection {
  return {
    slug: 'openai-codex',
    name: 'OpenAI OAuth',
    providerType: 'openai-codex',
    defaultModel: 'gpt-5.5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function githubCopilotConnection(): LlmConnection {
  return {
    slug: 'github-copilot',
    name: 'GitHub Copilot',
    providerType: 'github-copilot',
    baseUrl: 'https://api.githubcopilot.com',
    defaultModel: 'gpt-5.4',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function xaiOAuthConnection(): LlmConnection {
  return {
    slug: 'xai-oauth',
    name: 'xAI OAuth',
    providerType: 'xai-oauth',
    defaultModel: 'grok-4.5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function codexToken(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url');
  return `${header}.${payload}.signature`;
}
