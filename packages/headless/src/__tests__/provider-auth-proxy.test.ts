import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  listenProviderAuthProxyServer,
  startProviderAuthProxy,
  startProviderAuthProxyHub,
  summarizeProviderTelemetry,
} from '../provider-auth-proxy.js';

test('provider auth proxy keeps the provider key host-side', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-'));
  const providerKey = 'provider-secret-key';
  let upstreamAuthorization = '';
  let upstreamPath = '';
  const upstream = createServer((request, response) => {
    upstreamAuthorization = request.headers.authorization ?? '';
    upstreamPath = request.url ?? '';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, `${providerKey}\n`, 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/api/v4/`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
  });

  try {
    assert.notEqual(proxy.token, providerKey);
    assert.equal(new URL(proxy.baseUrl).pathname, '/api/v4');
    const unauthorized = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(upstreamAuthorization, '');

    const response = await fetch(`${proxy.baseUrl}/chat/completions?stream=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
    assert.equal(upstreamAuthorization, `Bearer ${providerKey}`);
    assert.equal(upstreamPath, '/api/v4/chat/completions?stream=true');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy rejects requests outside the upstream base path before resolving credentials', async () => {
  let credentialResolutions = 0;
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: 'http://127.0.0.1:1/coding/v1',
    advertisedHost: '127.0.0.1',
    resolveUpstreamCredential: async () => {
      credentialResolutions += 1;
      return { value: 'upstream-key' };
    },
  });

  try {
    for (const path of ['/other', '/coding/v10']) {
      const response = await fetch(`${new URL(proxy.baseUrl).origin}${path}`, {
        headers: { authorization: `Bearer ${proxy.token}` },
      });
      assert.equal(response.status, 404);
    }
    assert.equal(credentialResolutions, 0);
  } finally {
    await proxy.close();
  }
});

test('provider auth proxy ignores an absolute-form origin while preserving its path and query', async () => {
  let upstreamPath = '';
  const upstream = createServer((request, response) => {
    upstreamPath = request.url ?? '';
    response.writeHead(200).end('ok');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/coding/v1`,
    advertisedHost: '127.0.0.1',
    resolveUpstreamCredential: async () => ({ value: 'upstream-key' }),
  });

  try {
    const proxyUrl = new URL(proxy.baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: proxyUrl.hostname,
          port: proxyUrl.port,
          path: 'http://attacker.invalid/coding/v1/models/a%2Fb?view=full',
          headers: { authorization: `Bearer ${proxy.token}` },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.once('error', reject);
      request.end();
    });
    assert.equal(status, 200);
    assert.equal(upstreamPath, '/coding/v1/models/a%2Fb?view=full');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('provider auth proxy resolves rotating upstream credentials for every request', async () => {
  const authorizations: string[] = [];
  const accountIds: string[] = [];
  const upstream = createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? '');
    accountIds.push(String(request.headers['chatgpt-account-id'] ?? ''));
    response.writeHead(200).end('ok');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  let credentialVersion = 0;
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    advertisedHost: '127.0.0.1',
    resolveUpstreamCredential: async () => {
      credentialVersion += 1;
      return {
        value: `oauth-${credentialVersion}`,
        headers: { 'ChatGPT-Account-Id': `account-${credentialVersion}` },
      };
    },
  });

  try {
    for (let request = 0; request < 2; request += 1) {
      const response = await fetch(`${proxy.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${proxy.token}` },
        body: '{}',
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(authorizations, ['Bearer oauth-1', 'Bearer oauth-2']);
    assert.deepEqual(accountIds, ['account-1', 'account-2']);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('provider auth proxy hub routes concurrent leases independently on one listener', async () => {
  const upstreamRequests = new Map<string, Array<{ authorization: string; path: string }>>();
  const startUpstream = async (name: string) => {
    const requests: Array<{ authorization: string; path: string }> = [];
    upstreamRequests.set(name, requests);
    const upstream = createServer((request, response) => {
      requests.push({
        authorization: request.headers.authorization ?? '',
        path: request.url ?? '',
      });
      response.writeHead(200).end(name);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    return { upstream, url: `http://127.0.0.1:${address.port}` };
  };
  const [alphaUpstream, betaUpstream] = await Promise.all([
    startUpstream('alpha'),
    startUpstream('beta'),
  ]);
  const hub = await startProviderAuthProxyHub({ advertisedHost: '127.0.0.1' });
  const alpha = hub.issue({
    upstreamBaseUrl: `${alphaUpstream.url}/alpha/v1`,
    resolveUpstreamCredential: async () => ({ value: 'alpha-upstream-key' }),
  });
  const beta = hub.issue({
    upstreamBaseUrl: `${betaUpstream.url}/beta/v1`,
    resolveUpstreamCredential: async () => ({ value: 'beta-upstream-key' }),
  });

  try {
    assert.equal(new URL(alpha.baseUrl).origin, new URL(beta.baseUrl).origin);
    assert.equal(new URL(alpha.baseUrl).pathname, '/alpha/v1');
    assert.equal(new URL(beta.baseUrl).pathname, '/beta/v1');
    assert.notEqual(alpha.token, beta.token);
    const [alphaResponse, betaResponse] = await Promise.all([
      fetch(`${alpha.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${alpha.token}` },
        body: '{}',
      }),
      fetch(`${beta.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${beta.token}` },
        body: '{}',
      }),
    ]);
    assert.equal(await alphaResponse.text(), 'alpha');
    assert.equal(await betaResponse.text(), 'beta');
    assert.deepEqual(upstreamRequests.get('alpha'), [
      { authorization: 'Bearer alpha-upstream-key', path: '/alpha/v1/responses' },
    ]);
    assert.deepEqual(upstreamRequests.get('beta'), [
      { authorization: 'Bearer beta-upstream-key', path: '/beta/v1/responses' },
    ]);

    await alpha.close();
    const revoked = await fetch(`${alpha.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alpha.token}` },
      body: '{}',
    });
    assert.equal(revoked.status, 401);
    const stillActive = await fetch(`${beta.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${beta.token}` },
      body: '{}',
    });
    assert.equal(await stillActive.text(), 'beta');
  } finally {
    await Promise.allSettled([alpha.close(), beta.close()]);
    await hub.close();
    await Promise.all(
      [alphaUpstream.upstream, betaUpstream.upstream].map(
        (upstream) =>
          new Promise<void>((resolve, reject) =>
            upstream.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  }
});

test('provider auth proxy hub attributes usage and telemetry to each lease', async () => {
  const startUpstream = async (input: number, output: number) => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: input,
            prompt_tokens_details: { cached_tokens: input - 1 },
            completion_tokens: output,
          },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    return { upstream, url: `http://127.0.0.1:${address.port}` };
  };
  const [alphaUpstream, betaUpstream] = await Promise.all([
    startUpstream(11, 3),
    startUpstream(29, 7),
  ]);
  const hub = await startProviderAuthProxyHub({ advertisedHost: '127.0.0.1' });
  const alpha = hub.issue({
    upstreamBaseUrl: alphaUpstream.url,
    resolveUpstreamCredential: async () => ({ value: 'alpha-key' }),
    usageProtocol: 'openai-chat-sse',
  });
  const beta = hub.issue({
    upstreamBaseUrl: betaUpstream.url,
    resolveUpstreamCredential: async () => ({ value: 'beta-key' }),
    usageProtocol: 'openai-chat-sse',
  });

  try {
    await Promise.all(
      [alpha, beta].map(async (lease) => {
        const response = await fetch(`${lease.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${lease.token}` },
          body: '{}',
        });
        assert.equal(response.status, 200);
        await response.text();
      }),
    );
    assert.deepEqual(alpha.usage(), {
      input: 11,
      cacheRead: 10,
      cacheWrite: 0,
      output: 3,
    });
    assert.deepEqual(beta.usage(), {
      input: 29,
      cacheRead: 28,
      cacheWrite: 0,
      output: 7,
    });
    assert.deepEqual(
      alpha.telemetry().map((request) => request.usage),
      [alpha.usage()],
    );
    assert.deepEqual(
      beta.telemetry().map((request) => request.usage),
      [beta.usage()],
    );
  } finally {
    await Promise.allSettled([alpha.close(), beta.close()]);
    await hub.close();
    await Promise.all(
      [alphaUpstream.upstream, betaUpstream.upstream].map(
        (upstream) =>
          new Promise<void>((resolve, reject) =>
            upstream.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  }
});

test('provider auth proxy hub aborts only the closed lease requests', async () => {
  let alphaStarted!: () => void;
  const alphaReachedUpstream = new Promise<void>((resolve) => {
    alphaStarted = resolve;
  });
  const alphaUpstream = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('partial');
    alphaStarted();
    request.once('close', () => response.end());
  });
  const betaUpstream = createServer((_request, response) => {
    response.writeHead(200).end('beta');
  });
  await Promise.all(
    [alphaUpstream, betaUpstream].map(
      (upstream) => new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve)),
    ),
  );
  const alphaAddress = alphaUpstream.address();
  const betaAddress = betaUpstream.address();
  assert.ok(alphaAddress && typeof alphaAddress !== 'string');
  assert.ok(betaAddress && typeof betaAddress !== 'string');
  const hub = await startProviderAuthProxyHub({ advertisedHost: '127.0.0.1' });
  const alpha = hub.issue({
    upstreamBaseUrl: `http://127.0.0.1:${alphaAddress.port}`,
    resolveUpstreamCredential: async () => ({ value: 'alpha-key' }),
  });
  const beta = hub.issue({
    upstreamBaseUrl: `http://127.0.0.1:${betaAddress.port}`,
    resolveUpstreamCredential: async () => ({ value: 'beta-key' }),
  });

  try {
    const alphaBody = fetch(`${alpha.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alpha.token}` },
      body: '{}',
    }).then((response) => response.text());
    await alphaReachedUpstream;
    await alpha.close();
    await alphaBody.catch(() => undefined);

    const betaResponse = await fetch(`${beta.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${beta.token}` },
      body: '{}',
    });
    assert.equal(await betaResponse.text(), 'beta');
    assert.equal(alpha.telemetry().at(-1)?.outcome, 'aborted');
    assert.equal(beta.telemetry().at(-1)?.outcome, 'completed');
  } finally {
    await Promise.allSettled([alpha.close(), beta.close()]);
    await hub.close();
    await Promise.all(
      [alphaUpstream, betaUpstream].map(
        (upstream) =>
          new Promise<void>((resolve, reject) =>
            upstream.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  }
});

test('provider auth proxy supports Anthropic x-api-key without replacing the client user agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-anthropic-'));
  const providerKey = 'anthropic-provider-secret';
  let upstreamApiKey = '';
  let upstreamAuthorization = '';
  let upstreamUserAgent = '';
  let upstreamPath = '';
  const upstream = createServer((request, response) => {
    upstreamApiKey = String(request.headers['x-api-key'] ?? '');
    upstreamAuthorization = request.headers.authorization ?? '';
    upstreamUserAgent = request.headers['user-agent'] ?? '';
    upstreamPath = request.url ?? '';
    response.writeHead(200).end('ok');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, `${providerKey}\n`, 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/coding/v1`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    authMode: 'x-api-key',
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': proxy.token,
        'user-agent': 'opencode/1.17.18 ai-sdk/6',
      },
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamApiKey, providerKey);
    assert.equal(upstreamAuthorization, '');
    assert.equal(upstreamUserAgent, 'opencode/1.17.18 ai-sdk/6');
    assert.equal(upstreamPath, '/coding/v1/messages');
    assert.equal(proxy.telemetry()[0]?.path, '/coding/v1/messages');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy totals Anthropic streaming usage without changing the response bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-usage-'));
  const stream = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":70,"cache_creation_input_tokens":10,"cache_read_input_tokens":20,"output_tokens":1}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":25}}',
    '',
  ].join('\n');
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(stream.slice(0, 91));
    response.end(stream.slice(91));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    usageProtocol: 'anthropic-sse',
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    assert.equal(await response.text(), stream);
    assert.deepEqual(proxy.usage(), {
      input: 100,
      cacheRead: 20,
      cacheWrite: 10,
      output: 25,
    });
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy totals OpenAI chat streaming usage without changing the response bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-openai-usage-'));
  const stream = [
    'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25,"prompt_tokens_details":{"cached_tokens":20},"completion_tokens_details":{"reasoning_tokens":15}}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(stream.slice(0, 73));
    response.end(stream.slice(73));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    usageProtocol: 'openai-chat-sse',
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    assert.equal(await response.text(), stream);
    assert.deepEqual(proxy.usage(), {
      input: 100,
      cacheRead: 20,
      cacheWrite: 0,
      output: 25,
      reasoning: 15,
    });
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider telemetry summarizes output, reasoning, and stream-stall evidence', () => {
  assert.deepEqual(
    summarizeProviderTelemetry([
      {
        requestId: 1,
        method: 'POST',
        path: '/chat/completions',
        protocol: 'openai-chat-sse',
        status: 200,
        outcome: 'completed',
        firstOutputTokenMs: 250,
        lastOutputTokenMs: 350,
        firstReasoningTokenMs: 250,
        lastReasoningTokenMs: 300,
        reasoningEndMs: 450,
        maxBodyChunkGapMs: 175,
        durationMs: 500,
        bodyChunks: 4,
        responseBytes: 254,
        terminalEvent: true,
        usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 25, reasoning: 15 },
      },
    ]),
    {
      requests: 1,
      completed: 1,
      interrupted: 0,
      failed: 0,
      aborted: 0,
      inputTokens: 100,
      outputTokens: 25,
      reasoningTokens: 15,
      usageMeasuredRequests: 1,
      reasoningMeasuredRequests: 1,
      outputTokensPerSecond: 250,
      reasoningTokensPerSecond: 300,
      maxBodyChunkGapMs: 175,
    },
  );
});

test('provider auth proxy records token timing, stream stalls, and clean completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-telemetry-'));
  let clock = 1_000;
  const upstream = createServer(async (_request, response) => {
    clock = 1_100;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 1_250;
    response.write('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 1_500;
    response.write('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 1_700;
    response.write(
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25,"completion_tokens_details":{"reasoning_tokens":15}}}\n\n',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock = 1_750;
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    usageProtocol: 'openai-chat-sse',
    now: () => clock,
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    await response.text();
    const [request] = proxy.telemetry();
    assert.ok(request);
    assert.equal(request.outcome, 'completed');
    assert.equal(request.terminalEvent, true);
    assert.ok(request.responseHeadersMs! <= request.firstBodyChunkMs!);
    assert.ok(request.firstBodyChunkMs! <= request.firstOutputTokenMs!);
    assert.ok(request.firstOutputTokenMs! <= request.lastOutputTokenMs!);
    assert.ok(request.firstReasoningTokenMs! <= request.lastReasoningTokenMs!);
    assert.ok(request.lastOutputTokenMs! <= request.durationMs);
    assert.ok(request.maxBodyChunkGapMs! >= 0);
    assert.deepEqual(request.usage, {
      input: 100,
      cacheRead: 0,
      cacheWrite: 0,
      output: 25,
      reasoning: 15,
    });
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy marks a stream without its terminal event as interrupted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-interrupted-'));
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    usageProtocol: 'openai-chat-sse',
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    await response.text();
    assert.equal(proxy.telemetry()[0]?.outcome, 'interrupted');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy marks an upstream HTTP error as failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-http-error-'));
  const upstream = createServer((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end('{"error":"rate_limited"}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    assert.equal(response.status, 429);
    await response.text();
    assert.equal(proxy.telemetry()[0]?.outcome, 'failed');
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy forwards streaming response headers before the first body chunk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-stream-headers-'));
  let upstreamHeadersSent!: () => void;
  let releaseBody!: () => void;
  const headersSent = new Promise<void>((resolve) => {
    upstreamHeadersSent = resolve;
  });
  const bodyReleased = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });
  const upstream = createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    upstreamHeadersSent();
    await bodyReleased;
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
  });
  const pendingResponse = fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${proxy.token}` },
    body: '{}',
  });

  try {
    await headersSent;
    const headersForwarded = await Promise.race([
      pendingResponse.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    releaseBody();
    const response = await pendingResponse;
    assert.equal(headersForwarded, true, 'proxy held response headers until the first body chunk');
    assert.equal(await response.text(), 'data: [DONE]\n\n');
  } finally {
    releaseBody();
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy keeps unknown streaming usage schemas missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-unknown-usage-'));
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[],"usage":{"unknown_tokens":99}}\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    usageProtocol: 'openai-chat-sse',
  });

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    });
    await response.text();
    assert.equal(proxy.usage(), null);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy aborts an in-flight upstream request on close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-close-'));
  let received!: () => void;
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const upstream = createServer(() => {
    received();
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/api/v4`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
  });
  const pending = fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${proxy.token}` },
    body: '{}',
  });

  try {
    await requestReceived;
    await Promise.race([
      proxy.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('proxy close timed out')), 1_000),
      ),
    ]);
    await assert.rejects(pending);
    assert.equal(proxy.telemetry()[0]?.outcome, 'aborted');
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy cancels credential resolution on close', { timeout: 5_000 }, async () => {
  let markCredentialRequestStarted!: () => void;
  let markCredentialSocketClosed!: () => void;
  let releaseCredentialRequest = () => {};
  const credentialRequestStarted = new Promise<void>((resolve) => {
    markCredentialRequestStarted = resolve;
  });
  const credentialSocketClosed = new Promise<void>((resolve) => {
    markCredentialSocketClosed = resolve;
  });
  const credentialServer = createServer((request, response) => {
    markCredentialRequestStarted();
    request.socket.once('close', markCredentialSocketClosed);
    releaseCredentialRequest = () => {
      if (!response.writableEnded) response.end('upstream-key');
    };
  });
  await new Promise<void>((resolve) => credentialServer.listen(0, '127.0.0.1', resolve));
  const address = credentialServer.address();
  assert.ok(address && typeof address !== 'string');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: 'http://127.0.0.1:1',
    advertisedHost: '127.0.0.1',
    resolveUpstreamCredential: async (signal?: AbortSignal) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/credential`, {
        ...(signal ? { signal } : {}),
      });
      return { value: await response.text() };
    },
  });
  const providerResponse = fetch(`${proxy.baseUrl}/responses`, {
    headers: { authorization: `Bearer ${proxy.token}` },
  }).catch(() => undefined);

  try {
    await credentialRequestStarted;
    const closeAttempt = proxy.close();
    const closed = await Promise.race([
      closeAttempt.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    assert.equal(closed, true);
    const credentialSocketWasClosed = await Promise.race([
      credentialSocketClosed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    assert.equal(credentialSocketWasClosed, true);
    await providerResponse;
  } finally {
    releaseCredentialRequest();
    await proxy.close();
    credentialServer.closeAllConnections();
    await new Promise<void>((resolve) => credentialServer.close(() => resolve()));
  }
});

test('provider auth proxy closes when credential resolution ignores cancellation', {
  timeout: 5_000,
}, async () => {
  let markCredentialResolutionStarted!: () => void;
  let releaseCredentialResolution = () => {};
  const credentialResolutionStarted = new Promise<void>((resolve) => {
    markCredentialResolutionStarted = resolve;
  });
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: 'http://127.0.0.1:1',
    advertisedHost: '127.0.0.1',
    resolveUpstreamCredential: async () => {
      markCredentialResolutionStarted();
      return await new Promise((resolve) => {
        releaseCredentialResolution = () => resolve({ value: 'upstream-key' });
      });
    },
  });
  const providerResponse = fetch(`${proxy.baseUrl}/responses`, {
    headers: { authorization: `Bearer ${proxy.token}` },
  }).catch(() => undefined);

  try {
    await credentialResolutionStarted;
    const closed = await Promise.race([
      proxy.close().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    assert.equal(closed, true);
    await providerResponse;
  } finally {
    releaseCredentialResolution();
    await proxy.close();
  }
});

test('provider auth proxy aborts the upstream stream when its client disconnects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-client-disconnect-'));
  let upstreamClosed!: () => void;
  const upstreamResponseClosed = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  const upstream = createServer((_request, response) => {
    response.once('close', upstreamClosed);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'provider-secret-key\n', 'utf8');
  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyFile: keyFile,
    advertisedHost: '127.0.0.1',
    usageProtocol: 'openai-chat-sse',
  });
  const controller = new AbortController();

  try {
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
      signal: controller.signal,
    });
    const firstChunk = await response.body?.getReader().read();
    assert.equal(firstChunk?.done, false);
    controller.abort();
    await Promise.race([
      upstreamResponseClosed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('upstream stream was not aborted')), 1_000),
      ),
    ]);
    assert.equal(proxy.telemetry()[0]?.outcome, 'aborted');
  } finally {
    controller.abort();
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy binds a caller-specified port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-'));
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'k\n', 'utf8');
  // Grab a free port from the OS, then demand the proxy bind exactly it. An
  // unprivileged high port avoids the CAP_NET_BIND_SERVICE requirement that 80/443
  // (the only Squid-legal ports) would impose on Linux, while still exercising the
  // fixed-port path the Kimi arm relies on.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const probeAddress = probe.address();
  assert.ok(probeAddress && typeof probeAddress !== 'string');
  const port = probeAddress.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const proxy = await startProviderAuthProxy({
    upstreamBaseUrl: 'http://127.0.0.1:1/api',
    apiKeyFile: keyFile,
    advertisedHost: 'host.docker.internal',
    port,
  });
  try {
    assert.equal(proxy.baseUrl, `http://host.docker.internal:${port}/api`);
  } finally {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('provider auth proxy reports a clear error when a fixed port is unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-proxy-'));
  const keyFile = join(dir, 'provider-key');
  await writeFile(keyFile, 'k\n', 'utf8');
  const occupied = createServer();
  // Occupy the wildcard address the proxy also binds, so the collision is a real
  // EADDRINUSE on every platform (a loopback-only bind does not conflict with
  // 0.0.0.0 on macOS).
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const occupiedAddress = occupied.address();
  assert.ok(occupiedAddress && typeof occupiedAddress !== 'string');
  try {
    await assert.rejects(
      startProviderAuthProxy({
        upstreamBaseUrl: 'http://127.0.0.1:1/api',
        apiKeyFile: keyFile,
        port: occupiedAddress.port,
      }),
      (error: Error) =>
        error.message.includes(`failed to bind port ${occupiedAddress.port}`) &&
        /Squid egress|already in use/.test(error.message),
    );
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('proxy listen removes its bind-error listener so later socket errors stay loud', async () => {
  const server = createServer();
  await listenProviderAuthProxyServer(server, 0);
  try {
    // once()/off() must reference the same named handler. With the anonymous
    // wrapper regression, a listener remains registered after listen and a
    // post-listen server error would reject the already-settled bind promise —
    // silently swallowed instead of crashing loudly like on main.
    assert.equal(server.listenerCount('error'), 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
