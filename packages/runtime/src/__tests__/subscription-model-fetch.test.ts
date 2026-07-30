import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LlmConnection } from '@maka/core';
import { buildSubscriptionModelFetch } from '../subscription-model-fetch.js';

describe('subscription model fetch', () => {
  test('cloaks Claude subscription requests by default', async () => {
    let observedHeaders = new Headers();
    let observedBody = '';
    const modelFetch = buildSubscriptionModelFetch({
      connection: claudeSubscriptionConnection(),
      sessionId: 'session-123',
      modelId: 'claude-sonnet-4-5',
      fetchFn: async (_url, init) => {
        observedHeaders = new Headers(init?.headers);
        observedBody = String(init?.body ?? '');
        return Response.json({ ok: true });
      },
      claude: {
        deviceId: 'device-123',
        accountUuid: 'account-123',
      },
    });

    assert.ok(modelFetch);
    await modelFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'x-api-key': '' },
      body: JSON.stringify({
        stream: false,
        system: 'Use the Maka system prompt.',
        messages: [{ role: 'user', content: 'hello from Maka' }],
      }),
    });

    const body = JSON.parse(observedBody);
    assert.equal(observedHeaders.get('user-agent'), 'claude-cli/2.1.153 (external, cli)');
    assert.equal(observedHeaders.get('x-api-key'), null);
    assert.equal(observedHeaders.get('X-Claude-Code-Session-Id'), 'session-123');
    assert.equal(
      body.metadata.user_id,
      JSON.stringify({
        device_id: 'device-123',
        account_uuid: 'account-123',
        session_id: 'session-123',
      }),
    );
    assert.equal(body.system[0].text.startsWith('x-anthropic-billing-header:'), true);
    assert.equal(body.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
    assert.deepEqual(body.system[1].cache_control, { type: 'ephemeral' });
    assert.equal(body.system[2].text, 'Use the Maka system prompt.');
    assert.equal(body.cache_control, undefined);
  });

  test('leaves Claude subscription requests untouched when the cloak opt-out is disabled', async () => {
    const modelFetch = buildSubscriptionModelFetch({
      connection: claudeSubscriptionConnection(),
      sessionId: 'session-123',
      modelId: 'claude-sonnet-4-5',
      claude: {
        cloakEnabled: false,
        deviceId: 'device-123',
        accountUuid: 'account-123',
      },
    });

    assert.equal(modelFetch, undefined);
  });

  test('rejects Claude subscription cloaking without complete metadata', () => {
    assert.throws(
      () =>
        buildSubscriptionModelFetch({
          connection: claudeSubscriptionConnection(),
          sessionId: 'session-123',
          modelId: 'claude-sonnet-4-5',
        }),
      /Claude subscription cloaking requires deviceId and accountUuid metadata/,
    );
    assert.throws(
      () =>
        buildSubscriptionModelFetch({
          connection: claudeSubscriptionConnection(),
          sessionId: 'session-123',
          modelId: 'claude-sonnet-4-5',
          claude: {
            deviceId: 'device-123',
            accountUuid: '',
          },
        }),
      /Claude subscription cloaking requires deviceId and accountUuid metadata/,
    );
  });

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
        return Response.json({ error: { message: 'account is not authorized' } }, { status: 403 });
      },
    });

    assert.ok(modelFetch);
    await assert.rejects(
      modelFetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        body: JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
      }),
      /Codex OAuth request failed: HTTP 403/,
    );
    assert.equal(attempts, 1);
  });

  test('does not retry an HTML 403 when the body belongs to a Request object', async () => {
    let attempts = 0;
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async (request) => {
        attempts += 1;
        if (request instanceof Request) await request.text();
        return new Response('<html><title>Request rejected</title>', {
          status: 403,
          headers: { 'content-type': 'text/html', 'retry-after': '0' },
        });
      },
    });

    assert.ok(modelFetch);
    const request = new Request('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
    });
    await assert.rejects(modelFetch(request), /Codex OAuth request failed: HTTP 403/);
    assert.equal(request.bodyUsed, true);
    assert.equal(attempts, 1);
  });

  test('does not treat a null body override as clearing a Request body', async () => {
    let attempts = 0;
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async (request) => {
        attempts += 1;
        if (request instanceof Request) await request.text();
        return new Response('<html><title>Request rejected</title>', {
          status: 403,
          headers: { 'content-type': 'text/html', 'retry-after': '0' },
        });
      },
    });

    assert.ok(modelFetch);
    const request = new Request('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: JSON.stringify({ input: [{ role: 'user', content: 'hello' }] }),
    });
    await assert.rejects(
      modelFetch(request, { body: null }),
      /Codex OAuth request failed: HTTP 403/,
    );
    assert.equal(attempts, 1);
  });

  test('does not retry an HTML 403 with a non-string request body', async () => {
    let attempts = 0;
    const modelFetch = buildSubscriptionModelFetch({
      connection: openAiCodexConnection(),
      sessionId: 'session-123',
      modelId: 'gpt-5.6-sol',
      fetchFn: async () => {
        attempts += 1;
        return new Response('<html><title>Request rejected</title>', {
          status: 403,
          headers: { 'content-type': 'text/html', 'retry-after': '0' },
        });
      },
    });

    assert.ok(modelFetch);
    await assert.rejects(
      modelFetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        body: new Uint8Array([123, 125]),
      }),
      /Codex OAuth request failed: HTTP 403/,
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
});

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function claudeSubscriptionConnection(): LlmConnection {
  return {
    slug: 'claude-subscription',
    name: 'Claude OAuth',
    providerType: 'claude-subscription',
    defaultModel: 'claude-sonnet-4-5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
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
