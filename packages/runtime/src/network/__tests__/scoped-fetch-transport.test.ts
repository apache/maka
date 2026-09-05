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
import { createServer } from 'node:http';
import net from 'node:net';
import { describe, test } from 'node:test';
import { PROXY_DEFAULTS, type ProxySettings } from '@maka/core/settings/network-settings';
import {
  CONNECTION_EFFECT_ERROR_BODY_MAX_BYTES,
  CONNECTION_EFFECT_JSON_BODY_MAX_BYTES,
  ConnectionEffectFetchError,
  fetchForConnectionEffect,
} from '../../connection-effect-fetch.js';
import { runConnectionModelDiscoveryEffect } from '../../model-fetcher.js';
import { runConnectionTestEffect, testConnection } from '../../test-connection.js';
import { createConnectionEffectFetchTransport } from '../scoped-fetch-transport.js';

describe('connection effect network transport', () => {
  test('concurrent discovery uses immutable per-effect proxy snapshots', async () => {
    const firstProxy = await startConnectProxy(() =>
      jsonResponse(200, modelPayload('first-model')),
    );
    const secondProxy = await startConnectProxy(() =>
      jsonResponse(200, modelPayload('second-model')),
    );
    const firstSettings: ProxySettings = {
      ...PROXY_DEFAULTS,
      enabled: true,
      host: '127.0.0.1',
      port: firstProxy.port,
      username: 'effect-one',
      password: 'secret-one',
      bypassList: [],
    };
    const secondSettings: ProxySettings = {
      ...PROXY_DEFAULTS,
      enabled: true,
      host: '127.0.0.1',
      port: secondProxy.port,
      username: 'effect-two',
      password: 'secret-two',
      bypassList: [],
    };
    const firstTransport = createConnectionEffectFetchTransport(firstSettings);
    const secondTransport = createConnectionEffectFetchTransport(secondSettings);

    firstSettings.port = secondProxy.port;
    firstSettings.password = 'mutated-after-capture';

    try {
      const [first, second] = await Promise.all([
        runConnectionModelDiscoveryEffect(openAiConnection('first'), 'provider-key', {
          fetch: firstTransport.fetch,
        }),
        runConnectionModelDiscoveryEffect(openAiConnection('second'), 'provider-key', {
          fetch: secondTransport.fetch,
        }),
      ]);

      assert.deepEqual(first, { ok: true, models: [{ id: 'first-model' }] });
      assert.deepEqual(second, { ok: true, models: [{ id: 'second-model' }] });
      assert.deepEqual(firstProxy.proxyAuthorization, [
        `Basic ${Buffer.from('effect-one:secret-one').toString('base64')}`,
      ]);
      assert.deepEqual(secondProxy.proxyAuthorization, [
        `Basic ${Buffer.from('effect-two:secret-two').toString('base64')}`,
      ]);
    } finally {
      await Promise.all([
        firstTransport.close(),
        secondTransport.close(),
        firstProxy.close(),
        secondProxy.close(),
      ]);
    }
  });

  test('close terminates owned proxy resources and rejects later fetches', async () => {
    const proxy = await startConnectProxy(() => {
      const body = modelPayload('stream-model');
      return `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${
        Buffer.byteLength(body) + 100
      }\r\n\r\n${body}`;
    }, false);
    const transport = createConnectionEffectFetchTransport({
      ...PROXY_DEFAULTS,
      enabled: true,
      host: '127.0.0.1',
      port: proxy.port,
      bypassList: [],
    });

    try {
      const response = await transport.fetch('http://provider.invalid/v1/models');
      assert.equal(response.status, 200);
      assert.equal(proxy.sockets.size, 1);

      const socket = [...proxy.sockets][0]!;
      const socketClosed = waitForSocketClose(socket);
      await Promise.all([transport.close(), transport.close(), socketClosed]);
      assert.equal(proxy.sockets.size, 0);
      await assert.rejects(
        () => transport.fetch('http://provider.invalid/v1/models'),
        /transport is closed/,
      );
    } finally {
      await transport.close();
      await proxy.close();
    }
  });

  test('close terminates resources owned by a direct transport', async () => {
    const sockets = new Set<net.Socket>();
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      response.write('{"data":[');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    const port = await listen(server);
    const transport = createConnectionEffectFetchTransport(null);

    try {
      const response = await transport.fetch(`http://127.0.0.1:${port}/models`);
      assert.equal(response.status, 200);
      assert.equal(sockets.size, 1);

      const socket = [...sockets][0]!;
      const socketClosed = waitForSocketClose(socket);
      await Promise.all([transport.close(), transport.close(), socketClosed]);
      assert.equal(sockets.size, 0);
    } finally {
      await transport.close();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    }
  });

  test('body timeout remains active after response headers arrive', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      response.write('{"data":[');
    });
    const port = await listen(server);
    const transport = createConnectionEffectFetchTransport(null);

    try {
      const response = await fetchForConnectionEffect(
        transport.fetch,
        `http://127.0.0.1:${port}/models`,
        { timeoutMs: 50 },
      );
      await assert.rejects(
        response.readJson(),
        (error: unknown) => error instanceof ConnectionEffectFetchError && error.kind === 'timeout',
      );
    } finally {
      await transport.close();
      await closeServer(server);
    }
  });

  test('production proxied fetch keeps the deadline active while reading the body', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      response.write('{"data":[');
    });
    const port = await listen(server);

    try {
      const response = await fetchForConnectionEffect(
        undefined,
        `http://127.0.0.1:${port}/models`,
        // Leave enough time for the default production proxiedFetch path to
        // receive the response; its deadline must remain armed while the body stalls.
        { timeoutMs: 250 },
      );
      await assert.rejects(
        response.readJson(),
        (error: unknown) => error instanceof ConnectionEffectFetchError && error.kind === 'timeout',
      );
    } finally {
      await closeServer(server);
    }
  });

  test('oversized provider JSON and error bodies fail without escaping their bounds', async () => {
    const server = createServer((request, response) => {
      if (request.url?.startsWith('/models/')) {
        return respond(
          response,
          200,
          JSON.stringify({
            data: [
              {
                id: 'oversized-model',
                display_name: 'x'.repeat(CONNECTION_EFFECT_JSON_BODY_MAX_BYTES),
              },
            ],
          }),
        );
      }
      respond(response, 401, 's'.repeat(CONNECTION_EFFECT_ERROR_BODY_MAX_BYTES + 1));
    });
    const port = await listen(server);
    const transport = createConnectionEffectFetchTransport(null);

    try {
      const discovery = await runConnectionModelDiscoveryEffect(
        {
          ...openAiConnection('models'),
          baseUrl: `http://127.0.0.1:${port}/models/v1`,
        },
        'provider-key',
        { fetch: transport.fetch },
      );
      assert.deepEqual(discovery, { ok: false, error: { kind: 'invalid_response' } });

      const connectionTest = await runConnectionTestEffect(
        {
          providerType: 'moonshot',
          baseUrl: `http://127.0.0.1:${port}/test/v1`,
          enabledModelIds: ['moonshot-v1-8k'],
        },
        'provider-key',
        { fetch: transport.fetch },
      );
      assert.equal(connectionTest.ok, false);
      if (!connectionTest.ok) {
        assert.deepEqual(connectionTest.error, { kind: 'invalid_response' });
      }
    } finally {
      await transport.close();
      await closeServer(server);
    }
  });

  test('successful probes cancel an unused response body', async () => {
    let responseClosed: Promise<void> | undefined;
    const server = createServer((_request, response) => {
      responseClosed = new Promise((resolve) => response.once('close', resolve));
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      response.write('{"choices":[');
    });
    const port = await listen(server);
    const transport = createConnectionEffectFetchTransport(null);

    try {
      const outcome = await runConnectionTestEffect(
        {
          providerType: 'moonshot',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          enabledModelIds: ['moonshot-v1-8k'],
        },
        'provider-key',
        { fetch: transport.fetch },
      );
      assert.equal(outcome.ok, true);
      assert.ok(responseClosed);
      await responseClosed;
    } finally {
      await transport.close();
      await closeServer(server);
    }
  });

  test('discovery exposes closed classifications without provider response bodies', async () => {
    const server = createServer((request, response) => {
      const path = request.url ?? '';
      if (path.startsWith('/auth/')) return respond(response, 401, 'auth-body-secret');
      if (path.startsWith('/timeout/')) return respond(response, 408, 'timeout-body-secret');
      if (path.startsWith('/unavailable/')) {
        return respond(response, 503, 'provider-body-secret');
      }
      if (path.startsWith('/metadata/')) {
        return respond(
          response,
          200,
          JSON.stringify({
            data: [{ id: 'model-with-invalid-metadata', display_name: 'x'.repeat(513) }],
          }),
        );
      }
      if (path.startsWith('/invalid/')) return respond(response, 200, '{not-json');
      return respond(response, 400, 'unknown-body-secret');
    });
    const port = await listen(server);
    const transport = createConnectionEffectFetchTransport(null);

    try {
      const cases = [
        ['auth', 'auth'],
        ['timeout', 'timeout'],
        ['unavailable', 'provider_unavailable'],
        ['metadata', 'invalid_response'],
        ['invalid', 'invalid_response'],
        ['unknown', 'unknown'],
      ] as const;
      for (const [path, expectedKind] of cases) {
        const outcome = await runConnectionModelDiscoveryEffect(
          {
            ...openAiConnection(path),
            baseUrl: `http://127.0.0.1:${port}/${path}/v1`,
          },
          'provider-key',
          { fetch: transport.fetch },
        );
        assert.equal(outcome.ok, false);
        if (outcome.ok) continue;
        assert.equal(outcome.error.kind, expectedKind);
        assert.doesNotMatch(JSON.stringify(outcome), /body-secret|not-json/);
      }

      const network = await runConnectionModelDiscoveryEffect(
        {
          ...openAiConnection('network'),
          baseUrl: 'http://127.0.0.1:1/v1',
        },
        'provider-key',
        { fetch: transport.fetch },
      );
      assert.deepEqual(network, { ok: false, error: { kind: 'network' } });
    } finally {
      await transport.close();
      await closeServer(server);
    }
  });

  test('connection testing reuses provider logic with an explicit direct transport', async () => {
    const server = createServer((request, response) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      respond(response, 401, 'raw-provider-auth-detail');
    });
    const port = await listen(server);
    const transport = createConnectionEffectFetchTransport(null);

    try {
      const connection = {
        ...openAiConnection('test'),
        providerType: 'moonshot' as const,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        enabledModelIds: ['moonshot-v1-8k'],
      };
      const outcome = await runConnectionTestEffect(connection, 'provider-key', {
        fetch: transport.fetch,
      });

      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.deepEqual(outcome.error, { kind: 'auth', statusCode: 401 });
      assert.equal(outcome.modelId, undefined);
      assert.equal(typeof outcome.latencyMs, 'number');
      assert.deepEqual(Object.keys(outcome).sort(), ['error', 'latencyMs', 'ok']);
      assert.doesNotMatch(JSON.stringify(outcome), /raw-provider-auth-detail|errorMessage/);

      const legacy = await testConnection(connection, 'provider-key', undefined, {
        fetch: transport.fetch,
      });
      assert.match(legacy.errorMessage ?? '', /raw-provider-auth-detail/);
    } finally {
      await transport.close();
      await closeServer(server);
    }
  });
});

function openAiConnection(slug: string) {
  return {
    slug,
    name: slug,
    providerType: 'openai' as const,
    baseUrl: 'http://provider.invalid/v1',
    defaultModel: 'gpt-test',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function modelPayload(model: string): string {
  return JSON.stringify({ data: [{ id: model }] });
}

function jsonResponse(status: number, body: string): string {
  return `HTTP/1.1 ${status} OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(
    body,
  )}\r\nConnection: close\r\n\r\n${body}`;
}

function respond(response: import('node:http').ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body);
}

interface ConnectProxy {
  readonly port: number;
  readonly sockets: Set<net.Socket>;
  readonly proxyAuthorization: string[];
  readonly requestCount: number;
  close(): Promise<void>;
}

async function startConnectProxy(
  responseForRequest: () => string,
  closeAfterResponse = true,
): Promise<ConnectProxy> {
  const sockets = new Set<net.Socket>();
  const proxyAuthorization: string[] = [];
  let requestCount = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));

    let buffer = Buffer.alloc(0);
    let tunnelEstablished = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const requestHead = buffer.subarray(0, headerEnd).toString('latin1');
        buffer = buffer.subarray(headerEnd + 4);
        const authorization = requestHead.match(/\r\nproxy-authorization:\s*([^\r\n]+)/i)?.[1];
        if (authorization) proxyAuthorization.push(authorization);
        if (!tunnelEstablished && requestHead.startsWith('CONNECT ')) {
          tunnelEstablished = true;
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          continue;
        }

        requestCount += 1;
        assert.match(requestHead, /^GET (?:http:\/\/provider\.invalid)?\/v1\/models HTTP\/1\.1/);
        const response = responseForRequest();
        if (closeAfterResponse) socket.end(response);
        else socket.write(response);
        return;
      }
    });
  });
  const port = await listen(server);

  return {
    port,
    sockets,
    proxyAuthorization,
    get requestCount() {
      return requestCount;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function waitForSocketClose(socket: net.Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', () => resolve()));
}
