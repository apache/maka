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
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import { connect as connectTcp, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';

import {
  createOpenAiResponsesTransportState,
  OPENAI_RESPONSES_LANE_HEADER,
  webSocketProxyAgent,
} from '../openai-responses-websocket.js';
import { createProxiedFetchTransport } from '../network/scoped-fetch-transport.js';
import { classifyError, providerRetryMetadata } from '../provider-error-classification.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

describe('OpenAI Responses WebSocket transport', () => {
  test('reuses a turn socket and sends previous_response_id with delta-only input', async () => {
    const requests: Record<string, unknown>[] = [];
    const server = await websocketServer((socket) => {
      socket.on('message', (data) => {
        const body = JSON.parse(data.toString()) as Record<string, unknown>;
        requests.push(body);
        const index = requests.length;
        socket.send(
          JSON.stringify({
            type: 'response.created',
            response: { id: `resp-${index}`, created_at: 1, model: 'gpt-test' },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: `resp-${index}`,
              output: [{ type: 'message', id: `msg-${index}`, content: [] }],
            },
          }),
        );
      });
    });
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(globalThis.fetch);

    await consume(
      await fetch(server.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );
    await consume(
      await fetch(
        server.url,
        request('turn-1', {
          model: 'gpt-test',
          input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
          previous_response_id: 'resp-1',
        }),
      ),
    );

    assert.equal(server.connections(), 1);
    assert.deepEqual(requests[0], {
      type: 'response.create',
      model: 'gpt-test',
      input: [{ role: 'user' }],
    });
    assert.deepEqual(requests[1], {
      type: 'response.create',
      model: 'gpt-test',
      input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
      previous_response_id: 'resp-1',
    });
  });

  test('reconstructs the complete history for HTTP when WebSocket setup fails', async () => {
    const httpBodies: Record<string, unknown>[] = [];
    const httpFetch: typeof globalThis.fetch = async (_input, init) => {
      httpBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('http', { status: 200 });
    };
    const state = createOpenAiResponsesTransportState({ webSocketUrl: 'ws://127.0.0.1:1' });
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(httpFetch);

    const response = await fetch(
      'https://api.openai.com/v1/responses',
      request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] }),
    );

    assert.equal(await response.text(), 'http');
    assert.deepEqual(httpBodies, [{ model: 'gpt-test', stream: true, input: [{ role: 'user' }] }]);
    assert.equal(state.canRecordSemantic('turn-1', 'resp-any'), false);
  });

  test('skips WebSocket setup across turns during the failure cooldown and retries after it', async () => {
    let now = 1_000;
    let upgrades = 0;
    const server = createServer();
    server.on('upgrade', (_request, socket) => {
      upgrades += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    disposers.push(
      async () =>
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );

    const httpBodies: Record<string, unknown>[] = [];
    const state = createOpenAiResponsesTransportState({
      webSocketUrl: `ws://127.0.0.1:${address.port}/v1/responses`,
      failureCooldownMs: 1_000,
      now: () => now,
    });
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(async (_input, init) => {
      httpBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('http', { status: 200 });
    });

    const fullBody = { model: 'gpt-test', input: [{ role: 'user' }] };
    assert.equal(
      await (
        await fetch('https://api.openai.com/v1/responses', request('turn-1', fullBody))
      ).text(),
      'http',
    );
    state.endLane('turn-1');
    assert.equal(
      await (
        await fetch('https://api.openai.com/v1/responses', request('turn-2', fullBody))
      ).text(),
      'http',
    );
    assert.equal(upgrades, 1);

    state.endLane('turn-2');
    now += 1_001;
    assert.equal(
      await (
        await fetch('https://api.openai.com/v1/responses', request('turn-3', fullBody))
      ).text(),
      'http',
    );
    assert.equal(upgrades, 2);
    assert.equal(httpBodies.length, 3);
  });

  test('recovers the same lane after cooldown expiry and resumes delta transport', async () => {
    let now = 1_000;
    let upgrades = 0;
    let connections = 0;
    const requests: Record<string, unknown>[] = [];
    const http = createServer();
    const ws = new WebSocketServer({ noServer: true });
    const sockets = new Set<WebSocket>();
    http.on('upgrade', (request, socket, head) => {
      upgrades += 1;
      if (upgrades === 1) {
        socket.destroy();
        return;
      }
      ws.handleUpgrade(request, socket, head, (client) => ws.emit('connection', client, request));
    });
    ws.on('connection', (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('message', (data) => {
        requests.push(JSON.parse(data.toString()) as Record<string, unknown>);
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { id: `resp-${requests.length}`, output: [] },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address() as AddressInfo;
    disposers.push(async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });

    const httpBodies: Record<string, unknown>[] = [];
    const state = createOpenAiResponsesTransportState({
      webSocketUrl: `ws://127.0.0.1:${address.port}/v1/responses`,
      failureCooldownMs: 1_000,
      now: () => now,
    });
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(async (_input, init) => {
      httpBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('http', { status: 200 });
    });
    const fullBody = { model: 'gpt-test', input: [{ role: 'user', content: 'run it' }] };

    assert.equal(
      await (
        await fetch('https://api.openai.com/v1/responses', request('turn-1', fullBody))
      ).text(),
      'http',
    );
    state.endLane('turn-1');
    assert.equal(
      await (
        await fetch('https://api.openai.com/v1/responses', request('turn-2', fullBody))
      ).text(),
      'http',
    );
    assert.equal(upgrades, 1);

    now += 1_001;
    await consume(await fetch('https://api.openai.com/v1/responses', request('turn-2', fullBody)));
    await consume(
      await fetch(
        'https://api.openai.com/v1/responses',
        request('turn-2', {
          model: 'gpt-test',
          input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
          previous_response_id: 'resp-1',
        }),
      ),
    );

    assert.equal(upgrades, 2);
    assert.equal(connections, 1);
    assert.equal(httpBodies.length, 2);
    assert.deepEqual(requests, [
      { type: 'response.create', ...fullBody },
      {
        type: 'response.create',
        model: 'gpt-test',
        input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
        previous_response_id: 'resp-1',
      },
    ]);
  });

  test('keeps a healthy lane socket active while the cooldown suppresses new connections', async () => {
    let connectionIndex = 0;
    let healthyLaneRequests = 0;
    const server = await websocketServer((socket) => {
      connectionIndex += 1;
      const currentConnection = connectionIndex;
      socket.on('message', () => {
        if (currentConnection === 2) {
          socket.terminate();
          return;
        }
        healthyLaneRequests += 1;
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { id: `resp-${healthyLaneRequests}`, output: [] },
          }),
        );
      });
    });
    const httpBodies: Record<string, unknown>[] = [];
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(async (_input, init) => {
      httpBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('http', { status: 200 });
    });

    await consume(
      await fetch(server.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );
    const failed = await fetch(
      server.url,
      request('turn-2', { model: 'gpt-test', input: [{ role: 'user' }] }),
    );
    await assert.rejects(
      () => consume(failed),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /closed before completion/);
        assert.equal(
          (error as Error & { code?: string }).code,
          'OPENAI_RESPONSES_WEBSOCKET_TRANSPORT_ERROR',
        );
        assert.equal(classifyError(error), 'Network');
        assert.deepEqual(providerRetryMetadata(error), { retryable: true });
        return true;
      },
    );

    assert.equal(
      await (
        await fetch(server.url, request('turn-3', { model: 'gpt-test', input: [{ role: 'user' }] }))
      ).text(),
      'http',
    );
    await consume(
      await fetch(
        server.url,
        request('turn-1', {
          model: 'gpt-test',
          input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
          previous_response_id: 'resp-1',
        }),
      ),
    );

    assert.equal(server.connections(), 2);
    assert.equal(healthyLaneRequests, 2);
    assert.equal(httpBodies.length, 1);
  });

  test('falls back to HTTP for a concurrent request on a busy lane', async () => {
    let releaseFirst!: () => void;
    const firstCanComplete = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const server = await websocketServer((socket) => {
      socket.once('message', async () => {
        await firstCanComplete;
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp-1', output: [] },
          }),
        );
      });
    });
    const httpBodies: Record<string, unknown>[] = [];
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(async (_input, init) => {
      httpBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('http', { status: 200 });
    });

    const first = await fetch(
      server.url,
      request('turn-1', { model: 'gpt-test', input: [{ role: 'user', content: 'first' }] }),
    );
    const contender = await fetch(
      server.url,
      request('turn-1', { model: 'gpt-test', input: [{ role: 'user', content: 'second' }] }),
    );

    assert.equal(await contender.text(), 'http');
    assert.deepEqual(httpBodies, [
      { model: 'gpt-test', stream: true, input: [{ role: 'user', content: 'second' }] },
    ]);
    releaseFirst();
    await consume(first);
  });

  test('makes a stale continuation retryable and sends the retry through HTTP', async () => {
    const server = await websocketServer((socket) => {
      socket.once('message', () => {
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp-1', output: [] },
          }),
        );
      });
    });
    const httpBodies: Record<string, unknown>[] = [];
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(async (_input, init) => {
      httpBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('http', { status: 200 });
    });
    await consume(
      await fetch(server.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );

    const stale = await fetch(
      server.url,
      request('turn-1', {
        model: 'gpt-test',
        input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
        previous_response_id: 'stale-response',
      }),
    );
    await assert.rejects(
      () => consume(stale),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as Error & { code?: string }).code,
          'OPENAI_RESPONSES_CONTINUATION_UNAVAILABLE',
        );
        assert.deepEqual(providerRetryMetadata(error), { retryable: true });
        return true;
      },
    );

    assert.equal(
      await (
        await fetch(
          server.url,
          request('turn-1', {
            model: 'gpt-test',
            input: [{ role: 'user' }, { role: 'tool', content: 'ok' }],
          }),
        )
      ).text(),
      'http',
    );
    assert.equal(httpBodies.length, 1);
  });

  test('keeps an idle error listener on a reusable socket', async () => {
    let connection = 0;
    let firstSocket: WebSocket | undefined;
    const server = await websocketServer((socket) => {
      connection += 1;
      if (connection === 1) firstSocket = socket;
      socket.once('message', () => {
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { id: `resp-${connection}`, output: [] },
          }),
        );
      });
    });
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(globalThis.fetch);

    await consume(
      await fetch(server.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );
    assert.ok(firstSocket);
    const closed = once(firstSocket, 'close');
    const rawSocket = (firstSocket as unknown as { _socket: Duplex })._socket;
    // Reserved opcode 3 is an invalid server frame. ws emits `error` on the
    // idle client before closing; the permanent listener must absorb it.
    rawSocket.write(Buffer.from([0x83, 0x00]));
    await closed;

    await consume(
      await fetch(
        server.url,
        request('turn-1', {
          model: 'gpt-test',
          input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
          previous_response_id: 'resp-1',
        }),
      ),
    );
    assert.equal(server.connections(), 2);
  });

  test('fails binary frames as retryable transport errors', async () => {
    const server = await websocketServer((socket) => {
      socket.once('message', () => socket.send(Buffer.from([1, 2, 3])));
    });
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const response = await state.wrapFetch(globalThis.fetch)(
      server.url,
      request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] }),
    );

    await assert.rejects(
      () => consume(response),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Unexpected binary/);
        assert.deepEqual(providerRetryMetadata(error), { retryable: true });
        return true;
      },
    );
  });

  test('surfaces non-truncation incomplete responses but accepts max-output truncation', async () => {
    let requestIndex = 0;
    const server = await websocketServer((socket) => {
      socket.once('message', () => {
        requestIndex += 1;
        socket.send(
          JSON.stringify({
            type: 'response.incomplete',
            response: {
              id: `resp-${requestIndex}`,
              output: [],
              incomplete_details: {
                reason: requestIndex === 1 ? 'content_filter' : 'max_output_tokens',
              },
            },
          }),
        );
      });
    });
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(globalThis.fetch);

    const filtered = await fetch(
      server.url,
      request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] }),
    );
    await assert.rejects(() => consume(filtered), /stream incomplete \(content_filter\)/);

    const truncated = await fetch(
      server.url,
      request('turn-2', { model: 'gpt-test', input: [{ role: 'user' }] }),
    );
    assert.match(await consume(truncated), /data: \[DONE\]/);
    assert.equal(server.connections(), 2);
  });

  test('does not start the failure cooldown for a provider response.failed event', async () => {
    let requestIndex = 0;
    const server = await websocketServer((socket) => {
      socket.once('message', () => {
        requestIndex += 1;
        socket.send(
          JSON.stringify(
            requestIndex === 1
              ? {
                  type: 'response.failed',
                  sequence_number: 1,
                  response: {
                    error: { code: 'provider_error', message: 'provider rejected the response' },
                    incomplete_details: null,
                  },
                }
              : {
                  type: 'response.completed',
                  response: { id: 'resp-2', output: [] },
                },
          ),
        );
      });
    });
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(globalThis.fetch);

    const failed = await fetch(
      server.url,
      request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] }),
    );
    assert.match(await consume(failed), /response.failed/);
    await consume(
      await fetch(server.url, request('turn-2', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );

    assert.equal(server.connections(), 2);
  });

  test('aborts a live stream without entering the cross-turn failure cooldown', async () => {
    let requestIndex = 0;
    const server = await websocketServer((socket) => {
      socket.once('message', () => {
        requestIndex += 1;
        if (requestIndex === 2) {
          socket.send(
            JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp-2', output: [] },
            }),
          );
        }
      });
    });
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(globalThis.fetch);
    const abort = new AbortController();
    const pending = await fetch(
      server.url,
      request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] }, abort.signal),
    );
    abort.abort(new DOMException('Stopped', 'AbortError'));
    await assert.rejects(() => consume(pending), /Stopped/);

    await consume(
      await fetch(server.url, request('turn-2', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );
    assert.equal(server.connections(), 2);
  });

  test('aborts WebSocket setup without starting the failure cooldown', async () => {
    let acceptUpgrade = false;
    let upgrades = 0;
    let connections = 0;
    let observeFirstUpgrade!: () => void;
    const firstUpgrade = new Promise<void>((resolve) => {
      observeFirstUpgrade = resolve;
    });
    const http = createServer();
    const ws = new WebSocketServer({ noServer: true });
    const rawSockets = new Set<Duplex>();
    http.on('upgrade', (request, socket, head) => {
      upgrades += 1;
      rawSockets.add(socket);
      socket.on('close', () => rawSockets.delete(socket));
      if (!acceptUpgrade) {
        observeFirstUpgrade();
        return;
      }
      ws.handleUpgrade(request, socket, head, (client) => ws.emit('connection', client, request));
    });
    ws.on('connection', (socket) => {
      connections += 1;
      socket.once('message', () => {
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp-2', output: [] },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address() as AddressInfo;
    disposers.push(async () => {
      for (const socket of rawSockets) socket.destroy();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });

    let httpFallbacks = 0;
    const state = createOpenAiResponsesTransportState({
      webSocketUrl: `ws://127.0.0.1:${address.port}/v1/responses`,
    });
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(async () => {
      httpFallbacks += 1;
      return new Response('http', { status: 200 });
    });
    const abort = new AbortController();
    const connecting = fetch(
      'https://api.openai.com/v1/responses',
      request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] }, abort.signal),
    );
    await firstUpgrade;
    abort.abort(new DOMException('Stopped during setup', 'AbortError'));
    await assert.rejects(() => connecting, /Stopped during setup/);

    acceptUpgrade = true;
    await consume(
      await fetch(
        'https://api.openai.com/v1/responses',
        request('turn-2', { model: 'gpt-test', input: [{ role: 'user' }] }),
      ),
    );
    assert.equal(upgrades, 2);
    assert.equal(connections, 1);
    assert.equal(httpFallbacks, 0);
  });

  test('uses the HTTP/SOCKS proxy snapshot and honors the same bypass list', () => {
    const httpTransport = createProxiedFetchTransport({
      enabled: true,
      type: 'http',
      host: 'proxy.local',
      port: 8080,
      username: 'user',
      password: 'secret',
      bypassList: ['bypass.test'],
    });
    const socksTransport = createProxiedFetchTransport({
      enabled: true,
      type: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      bypassList: [],
    });
    disposers.push(httpTransport.close, socksTransport.close);

    assert.equal(
      webSocketProxyAgent(httpTransport.fetch, 'https://api.openai.com/v1/responses')?.constructor
        .name,
      'HttpsProxyAgent',
    );
    assert.equal(
      webSocketProxyAgent(httpTransport.fetch, 'https://bypass.test/v1/responses'),
      undefined,
    );
    assert.equal(
      webSocketProxyAgent(socksTransport.fetch, 'https://api.openai.com/v1/responses')?.constructor
        .name,
      'SocksProxyAgent',
    );
  });

  test('connects through the configured authenticated HTTP proxy', async () => {
    const target = await websocketServer((socket) => {
      socket.once('message', () => {
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp-proxied', output: [] },
          }),
        );
      });
    });
    const proxy = await connectProxyServer();
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const transport = createProxiedFetchTransport({
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: proxy.port,
      username: 'proxy-user',
      password: 'proxy-secret',
      bypassList: [],
    });
    disposers.push(transport.close);
    const fetch = state.wrapFetch(transport.fetch);

    await consume(
      await fetch(target.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );

    assert.equal(proxy.connections(), 1);
    assert.equal(target.connections(), 1);
    assert.equal(
      proxy.authorization(),
      `Basic ${Buffer.from('proxy-user:proxy-secret').toString('base64')}`,
    );
  });

  test('reconnects with complete history instead of using a socket-local id', async () => {
    const requests: Record<string, unknown>[] = [];
    let connectionClosed: Promise<void> | undefined;
    const server = await websocketServer((socket) => {
      connectionClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.once('message', (data) => {
        requests.push(JSON.parse(data.toString()) as Record<string, unknown>);
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: `resp-${requests.length}`,
              output: [{ type: 'function_call', call_id: 'call-1', name: 'shell' }],
            },
          }),
        );
        socket.close();
      });
    });
    const state = createOpenAiResponsesTransportState();
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(globalThis.fetch);

    await consume(
      await fetch(server.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );
    await connectionClosed;
    await consume(
      await fetch(
        server.url,
        request('turn-1', {
          model: 'gpt-test',
          input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
          previous_response_id: 'resp-1',
        }),
      ),
    );

    assert.equal(server.connections(), 2);
    assert.deepEqual(requests[1], {
      type: 'response.create',
      model: 'gpt-test',
      input: [
        { role: 'user' },
        { type: 'function_call', call_id: 'call-1', name: 'shell' },
        { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
      ],
    });
  });

  test('reconstructs prior input, provider output, and the delta when a reused lane falls back', async () => {
    const httpBodies: Record<string, unknown>[] = [];
    let connectionClosed: Promise<void> | undefined;
    const server = await websocketServer((socket) => {
      connectionClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.once('message', () => {
        socket.send(
          JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp-1',
              output: [{ type: 'function_call', call_id: 'call-1', name: 'shell' }],
            },
          }),
          () => socket.close(),
        );
      });
    });
    const state = createOpenAiResponsesTransportState({ connectTimeoutMs: 100 });
    disposers.push(async () => state.close());
    const fetch = state.wrapFetch(async (_input, init) => {
      httpBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('http', { status: 200 });
    });

    await consume(
      await fetch(server.url, request('turn-1', { model: 'gpt-test', input: [{ role: 'user' }] })),
    );
    await connectionClosed;
    await server.stopWebSockets();
    const response = await fetch(
      server.url,
      request('turn-1', {
        model: 'gpt-test',
        input: [{ type: 'function_call_output', call_id: 'call-1', output: 'ok' }],
        previous_response_id: 'resp-1',
      }),
    );

    assert.equal(await response.text(), 'http');
    assert.deepEqual(httpBodies, [
      {
        model: 'gpt-test',
        stream: true,
        input: [
          { role: 'user' },
          { type: 'function_call', call_id: 'call-1', name: 'shell' },
          { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
        ],
      },
    ]);
  });
});

function request(lane: string, body: Record<string, unknown>, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer test',
      'content-type': 'application/json',
      [OPENAI_RESPONSES_LANE_HEADER]: lane,
    },
    body: JSON.stringify({ ...body, stream: true }),
    ...(signal ? { signal } : {}),
  };
}

async function consume(response: Response): Promise<string> {
  return await response.text();
}

async function websocketServer(
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
) {
  const http = createServer();
  const sockets = new Set<WebSocket>();
  const ws = new WebSocketServer({ server: http });
  let connections = 0;
  ws.on('connection', (socket, request) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket, request);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/v1/responses`;
  let webSocketsStopped = false;
  const stopWebSockets = async () => {
    if (webSocketsStopped) return;
    webSocketsStopped = true;
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
  };
  disposers.push(async () => {
    await stopWebSockets();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { url, connections: () => connections, stopWebSockets };
}

async function connectProxyServer() {
  const server = createServer();
  const sockets = new Set<Duplex>();
  let connections = 0;
  let authorization: string | undefined;
  server.on('connect', (request, client, head) => {
    connections += 1;
    authorization = request.headers['proxy-authorization'];
    const [host, rawPort] = (request.url ?? '').split(':');
    const upstream = connectTcp(Number(rawPort), host);
    sockets.add(client);
    sockets.add(upstream);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  disposers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    port: address.port,
    connections: () => connections,
    authorization: () => authorization,
  };
}
