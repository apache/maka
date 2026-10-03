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
import { createServer as createHttpsServer } from 'node:https';
import { createSecureServer as createHttp2Server } from 'node:http2';
import tls from 'node:tls';
import net from 'node:net';
import { getEventListeners } from 'node:events';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
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
import { testProxyConnection } from '../proxy-test.js';
import { proxiedFetch } from '../../bots/proxied-fetch.js';
import { setActiveProxy } from '../active-proxy-state.js';
import { buildProxyDispatcher } from '../proxy-dispatcher.js';
import { buildAbortableConnector } from '../abortable-connector.js';

describe('connection effect network transport', () => {
  for (const type of ['direct', 'http', 'socks5'] as const) {
    test(`closed successful connections do not accumulate abort listeners (${type})`, async () => {
      const server = createServer((_request, response) => {
        response.writeHead(200, { connection: 'close' });
        response.end('proxy-ok');
      });
      const port = await listen(server);
      const socks = type === 'socks5' ? await startStalledProxy('socks-http') : undefined;
      const controller = new AbortController();
      const dispatcher =
        type === 'direct'
          ? new Agent({ connect: buildAbortableConnector(controller.signal) })
          : buildProxyDispatcher(
              {
                ...PROXY_DEFAULTS,
                enabled: true,
                type,
                host: '127.0.0.1',
                port: socks?.port ?? port,
                bypassList: [],
              },
              controller.signal,
            );
      try {
        for (let index = 0; index < 25; index++) {
          const response = await undiciFetch(
            type === 'direct'
              ? `http://127.0.0.1:${port}/models`
              : 'http://provider.invalid/models',
            { dispatcher },
          );
          assert.equal(await response.text(), 'proxy-ok');
          // Socket close is delivered after the body. Wait for I/O, not GC.
          await waitFor(() => getEventListeners(controller.signal, 'abort').length === 0, {
            timeoutMs: 1_000,
            message: 'closed socket retained an abort listener',
          });
        }
      } finally {
        controller.abort();
        await dispatcher.destroy();
        await socks?.close();
        await closeServer(server);
      }
    });
  }

  for (const stage of [
    'direct',
    'http-tls',
    'https-proxy-tls',
    'https-proxy-tls-forward',
    'socks-tls',
  ] as const) {
    test(`failed TLS connections do not accumulate abort listeners (${stage})`, async () => {
      const proxy = await startStalledProxy(stage === 'direct' ? 'https-proxy-tls' : stage, true);
      const controller = new AbortController();
      const dispatcher =
        stage === 'direct'
          ? new Agent({ connect: buildAbortableConnector(controller.signal) })
          : buildProxyDispatcher(
              {
                ...PROXY_DEFAULTS,
                enabled: true,
                type:
                  stage === 'socks-tls'
                    ? 'socks5'
                    : stage.startsWith('https-proxy-tls')
                      ? 'https'
                      : 'http',
                host: '127.0.0.1',
                port: proxy.port,
                bypassList: [],
              },
              controller.signal,
            );
      try {
        for (let index = 0; index < 25; index++) {
          await assert.rejects(
            undiciFetch(
              stage === 'direct'
                ? `https://127.0.0.1:${proxy.port}/models`
                : `${stage.endsWith('-forward') ? 'http' : 'https'}://provider.invalid/models`,
              { dispatcher },
            ),
          );
          await waitFor(() => getEventListeners(controller.signal, 'abort').length === 0, {
            timeoutMs: 1_000,
            message: 'failed TLS socket retained an abort listener',
          });
        }
      } finally {
        controller.abort();
        await dispatcher.destroy();
        await proxy.close();
      }
    });
  }

  test('SOCKS leaves the negotiation deadline to SocksClient after TCP connects', async (t) => {
    const proxy = await startStalledProxy('socks-greeting');
    const sockets = new Set<net.Socket>();
    const original = net.Socket.prototype.setTimeout;
    t.mock.method(
      net.Socket.prototype,
      'setTimeout',
      function (this: net.Socket, ...args: Parameters<typeof original>) {
        sockets.add(this);
        return original.apply(this, args);
      },
    );
    const transport = createConnectionEffectFetchTransport({
      ...PROXY_DEFAULTS,
      enabled: true,
      type: 'socks5',
      host: '127.0.0.1',
      port: proxy.port,
      bypassList: [],
    });
    const request = transport.fetch('https://provider.invalid/models').catch(() => undefined);
    try {
      await withTimeout(proxy.started, 2_000, 'SOCKS greeting did not start');
      const socket = [...sockets].find((entry) => entry.remotePort === proxy.port);
      assert.ok(socket);
      assert.equal(socket.timeout, 0, 'TCP timeout must be cleared before SOCKS negotiation');
    } finally {
      await transport.close();
      await proxy.close();
      await request;
    }
  });

  for (const authenticated of [false, true]) {
    test(`SOCKS preserves remote DNS and successful HTTP responses (auth: ${authenticated})`, async () => {
      const proxy = await startStalledProxy(authenticated ? 'socks-auth-http' : 'socks-http');
      const transport = createConnectionEffectFetchTransport({
        ...PROXY_DEFAULTS,
        enabled: true,
        type: 'socks5',
        host: '127.0.0.1',
        port: proxy.port,
        username: authenticated ? 'proxy-user' : '',
        password: authenticated ? 'proxy-password' : '',
        bypassList: [],
      });
      try {
        const response = await withTimeout(
          transport.fetch('http://provider.invalid/models'),
          2_000,
          'SOCKS request did not finish',
        );
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'proxy-ok');
      } finally {
        await transport.close();
        await proxy.close();
      }
    });
  }

  for (const type of ['http', 'https', 'socks5'] as const) {
    test(`immediate close rejects pending and subsequent requests (${type})`, async () => {
      const proxy = await startStalledProxy(
        type === 'socks5'
          ? 'socks-greeting'
          : type === 'https'
            ? 'https-proxy-tls'
            : 'http-connect',
      );
      const transport = createConnectionEffectFetchTransport({
        ...PROXY_DEFAULTS,
        enabled: true,
        type,
        host: '127.0.0.1',
        port: proxy.port,
        bypassList: [],
      });
      try {
        const request = assert.rejects(transport.fetch('https://provider.invalid/models'));
        const closed = transport.close();
        assert.equal(transport.close(), closed);
        await withTimeout(Promise.all([request, closed]), 2_000, 'immediate close did not finish');
        await assert.rejects(
          transport.fetch('https://provider.invalid/models'),
          /transport is closed/,
        );
      } finally {
        await transport.close();
        await proxy.close();
      }
    });
  }

  test('proxy connection probe timeout releases its pending TLS tunnel', async () => {
    const proxy = await startStalledProxy('http-tls');
    const settings = {
      ...PROXY_DEFAULTS,
      enabled: true,
      type: 'http' as const,
      host: '127.0.0.1',
      port: proxy.port,
      bypassList: [],
    };
    const request = testProxyConnection({
      proxy: settings,
      url: 'https://provider.invalid/models',
      timeoutMs: 500,
    });
    try {
      await withTimeout(proxy.started, 2_000, 'probe did not start TLS');
      const closed = waitForSocketClose([...proxy.sockets][0]!);
      const result = await withTimeout(request, 2_000, 'probe did not time out');
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /timeout/i);
      await withTimeout(closed, 1_000, 'probe TLS socket survived timeout');
    } finally {
      await proxy.close();
      await request;
    }
  });

  for (const abortRequest of [false, true]) {
    test(`bot proxy fetch releases pending TLS (caller abort: ${abortRequest})`, async () => {
      const proxy = await startStalledProxy('http-tls');
      setActiveProxy({
        ...PROXY_DEFAULTS,
        enabled: true,
        type: 'http',
        host: '127.0.0.1',
        port: proxy.port,
        bypassList: [],
      });
      const abort = new AbortController();
      const request = proxiedFetch('https://provider.invalid/models', {
        signal: abort.signal,
        timeoutMs: abortRequest ? 0 : 500,
      }).catch((error: unknown) => error);
      try {
        await withTimeout(proxy.started, 2_000, 'bot fetch did not start TLS');
        const closed = waitForSocketClose([...proxy.sockets][0]!);
        if (abortRequest) abort.abort();
        assert.ok(
          (await withTimeout(request, 2_000, 'bot fetch did not terminate')) instanceof Error,
        );
        await withTimeout(closed, 1_000, 'bot TLS socket survived cancellation');
      } finally {
        abort.abort();
        await proxy.close();
        await request;
        setActiveProxy(null);
      }
    });
  }

  for (const stage of [
    'http-connect',
    'http-tls',
    'https-proxy-tls',
    'https-proxy-tls-forward',
    'socks-greeting',
    'socks-connect',
    'socks-tls',
  ] as const) {
    for (const abortRequest of [false, true]) {
      test(`close releases pending ${stage} (request aborted: ${abortRequest})`, {
        timeout: 5_000,
      }, async () => {
        const proxy = await startStalledProxy(stage);
        const transport = createConnectionEffectFetchTransport({
          ...PROXY_DEFAULTS,
          enabled: true,
          type: stage.startsWith('socks')
            ? 'socks5'
            : stage.startsWith('https-proxy-tls')
              ? 'https'
              : 'http',
          host: '127.0.0.1',
          port: proxy.port,
          bypassList: [],
        });
        const abort = new AbortController();
        const request = fetchForConnectionEffect(
          transport.fetch,
          `${stage.endsWith('-forward') ? 'http' : 'https'}://provider.invalid/models`,
          { signal: abort.signal, timeoutMs: 0 },
        ).catch((error: unknown) => error);
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await withTimeout(proxy.started, 2_000, `${stage} did not start`);
          const socket = [...proxy.sockets][0]!;
          const closed = waitForSocketClose(socket);
          if (abortRequest) abort.abort();
          await transport.close();
          await Promise.race([
            closed,
            new Promise<never>((_resolve, reject) => {
              deadline = setTimeout(
                () => reject(new Error(`${stage} socket survived transport.close()`)),
                1_000,
              );
            }),
          ]);
          const outcome = await request;
          assert.ok(outcome instanceof ConnectionEffectFetchError);
          assert.equal(outcome.kind, 'network');
        } finally {
          clearTimeout(deadline);
          abort.abort();
          await transport.close();
          await proxy.close();
          await request;
        }
      });
    }
  }

  for (const abortRequest of [false, true]) {
    test(`close releases a pending TLS handshake (request aborted: ${abortRequest})`, async () => {
      const sockets = new Set<net.Socket>();
      let handshakeStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        handshakeStarted = resolve;
      });
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        // Read the ClientHello but never answer it. No external networking or
        // certificate configuration is needed to hold the connector in flight.
        socket.once('data', handshakeStarted);
        socket.resume();
      });
      const port = await listen(server);
      const transport = createConnectionEffectFetchTransport(null);
      const abort = new AbortController();
      const request = fetchForConnectionEffect(
        transport.fetch,
        `https://127.0.0.1:${port}/models`,
        {
          signal: abort.signal,
          timeoutMs: 0,
        },
      ).catch((error: unknown) => error);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await started;
        const socket = [...sockets][0]!;
        const closed = waitForSocketClose(socket);
        if (abortRequest) abort.abort();
        await transport.close();
        // Observe peer closure before the connector's own 10 s timeout could
        // hide an unowned socket. This is a failure bound, not a fixed sleep.
        await Promise.race([
          closed,
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error('TLS socket survived transport.close()')),
              1_000,
            );
          }),
        ]);
        const outcome = await request;
        assert.ok(outcome instanceof ConnectionEffectFetchError);
        assert.equal(outcome.kind, 'network');
      } finally {
        clearTimeout(deadline);
        abort.abort();
        await transport.close();
        for (const socket of sockets) socket.destroy();
        await closeServer(server);
        await request;
      }
    });
  }

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

  for (const protocol of ['http/1.1', 'h2'] as const) {
    for (const stalledDestroy of [false, true]) {
      test(`close settles after a successful ${protocol} CONNECT request (destroy stalled: ${stalledDestroy})`, async (t) => {
        const body = modelPayload('proxy-model');
        const originalConnect = tls.connect;
        t.mock.method(tls, 'connect', (options: tls.ConnectionOptions, callback?: () => void) =>
          originalConnect({ ...options, ca: CONNECT_TEST_CERT }, callback),
        );
        const proxy = await startSuccessfulTlsConnectProxy(body, protocol);
        const transport = createConnectionEffectFetchTransport({
          ...PROXY_DEFAULTS,
          enabled: true,
          type: 'http',
          host: '127.0.0.1',
          port: proxy.port,
          bypassList: [],
        });
        try {
          const response = await transport.fetch('https://provider.invalid/v1/models');
          assert.equal(response.status, 200);
          assert.equal(await response.text(), body);
          assert.equal(proxy.httpVersion, protocol === 'h2' ? '2.0' : '1.1');
          assert.equal(proxy.sockets.size, 2);
          const socketsClosed = Promise.all([...proxy.sockets].map(waitForSocketClose));
          if (stalledDestroy) {
            // Reproduce the dispatcher completion failure independently of Undici/Node version.
            t.mock.method(ProxyAgent.prototype, 'destroy', () => new Promise<void>(() => {}));
          }
          const closed = transport.close();
          assert.equal(transport.close(), closed);
          await withTimeout(
            closed,
            stalledDestroy ? 2_000 : 750,
            'completed CONNECT tunnel blocked transport.close()',
          );
          await withTimeout(socketsClosed, 1_000, 'CONNECT tunnel survived transport.close()');
          assert.equal(proxy.sockets.size, 0);
          await assert.rejects(
            transport.fetch('https://provider.invalid/v1/models'),
            /transport is closed/,
          );
        } finally {
          // Also release the server if a regression leaves dispatcher teardown pending.
          void transport.close();
          await proxy.close();
        }
      });
    }
  }

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

async function startSuccessfulTlsConnectProxy(body: string, protocol: 'http/1.1' | 'h2') {
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };
  let httpVersion: string | undefined;
  const options = { key: CONNECT_TEST_KEY, cert: CONNECT_TEST_CERT };
  const target =
    protocol === 'h2'
      ? createHttp2Server(options, (req, res) => {
          httpVersion = req.httpVersion;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(body);
        })
      : createHttpsServer(options, (req, res) => {
          httpVersion = req.httpVersion;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(body);
        });
  const targetPort = await listen(target);
  const proxy = createServer();
  proxy.on('connect', (request, socket, head) => {
    assert.equal(request.url, 'provider.invalid:443');
    track(socket as net.Socket);
    const tunnel = net.connect(targetPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) tunnel.write(head);
      socket.pipe(tunnel).pipe(socket);
    });
    track(tunnel);
    socket.once('close', () => tunnel.destroy());
    tunnel.once('close', () => socket.destroy());
  });
  return {
    port: await listen(proxy),
    sockets,
    get httpVersion() {
      return httpVersion;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([closeServer(proxy), closeServer(target)]);
    },
  };
}

async function startStalledProxy(stage: string, rejectTls = false) {
  const sockets = new Set<net.Socket>();
  let started!: () => void;
  const reachedStage = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let phase = stage.startsWith('socks')
      ? 'greeting'
      : stage.startsWith('https-proxy-tls')
        ? 'tls'
        : 'http';
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (phase === 'tls') {
        assert.equal(buffer[0], 22, 'expected a TLS handshake record');
        phase = 'stalled';
        started();
        if (rejectTls) socket.destroy();
      } else if (phase === 'http' && buffer.includes('\r\n\r\n')) {
        assert.match(buffer.toString('latin1'), /^CONNECT provider\.invalid:443 /);
        buffer = Buffer.alloc(0);
        if (stage === 'http-connect') {
          phase = 'stalled';
          started();
        } else {
          phase = 'tls';
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        }
      } else if (phase === 'response' && buffer.includes('\r\n\r\n')) {
        assert.match(buffer.toString('latin1'), /^GET \/models /);
        phase = 'done';
        socket.end(jsonResponse(200, 'proxy-ok'));
      } else if (phase === 'greeting' && buffer.length >= 2 + buffer[1]!) {
        assert.equal(buffer[0], 5);
        if (stage === 'socks-auth-http') assert.ok(buffer.subarray(2).includes(2));
        buffer = Buffer.alloc(0);
        if (stage === 'socks-greeting') {
          phase = 'stalled';
          started();
        } else {
          phase = stage === 'socks-auth-http' ? 'auth' : 'socks-connect';
          socket.write(Buffer.from([5, stage === 'socks-auth-http' ? 2 : 0]));
        }
      } else if (phase === 'auth' && buffer.length >= 3 + buffer[1]!) {
        const nameLength = buffer[1]!;
        const passwordLength = buffer[2 + nameLength]!;
        if (buffer.length < 3 + nameLength + passwordLength) return;
        assert.equal(buffer[0], 1);
        assert.equal(buffer.subarray(2, 2 + nameLength).toString(), 'proxy-user');
        assert.equal(buffer.subarray(3 + nameLength).toString(), 'proxy-password');
        buffer = Buffer.alloc(0);
        phase = 'socks-connect';
        socket.write(Buffer.from([1, 0]));
      } else if (phase === 'socks-connect' && buffer.length >= 5) {
        assert.equal(buffer[3], 3, 'the destination hostname must be resolved by the proxy');
        if (buffer.length < 7 + buffer[4]!) return;
        assert.equal(buffer.subarray(5, 5 + buffer[4]!).toString(), 'provider.invalid');
        buffer = Buffer.alloc(0);
        if (stage === 'socks-connect') {
          phase = 'stalled';
          started();
        } else {
          phase = stage.endsWith('-http') ? 'response' : 'tls';
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        }
      }
    });
  });
  return {
    port: await listen(server),
    sockets,
    started: reachedStage,
    async close() {
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
    },
  };
}

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

// Self-signed provider.invalid certificate/key generated solely for this loopback test.
const CONNECT_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQComV5/ZCsvuz3k
WLFXGECmg4HUM1fw9gdNjJOKf1jpupmeeG1RHwaI0CM+hdhVbzwUPKd9s8dU/y4o
jl9enwSuuu5ypPzxlnkCBje1xGL3XHw4KGE+F6ytyZFu2/3649GqYW8lzuFIvcPE
gzshEYa/3miliQz1Xyb77X9gjHXZawnokOM+Ci6lLHwvS7K4/hOUVWT43HcFdKzc
xEoiktcuSAm/klImsZodxwUy9V+E+PXzz0aDhyLOb1PfYmycPUY5WTUSl14+/iSB
01/hCqQ0lua8SsxNQyTxe7CpBvhX+dyBFY8PNHIayW6CcKSENUmsgbxnRg2hXgAo
Qp0LN1YZAgMBAAECggEAE26AyA8yFIlgueSYhOSeT+q8gAnuXu7mOtOCzj288ExR
yARSehzoroRJqZs4yqj8PEtc1QWvSc4y4lj9aC0M97wC/zrhjdEVT4zKpzQUIXUa
+oh547OMEwgWL1gi2sOe3sOl0S5Zw/3eFjQ3UImB9bNzLXABKrcdqb/O1GB/9S+7
enh7eyk2tz3pEPPtLQeKYuDOH3WwyGRsM2oGDnFiFOWHfU/SRxp8olipgX35jO93
USrxJDDrj52ZY31w4SQdETqSOf9/poypI9gEFrSC4eDeKNpNb/EcYdurt/LmtuCD
p3nTvaVy2Zyi5L4BKdo2YTy78lW4MDWlGNSYsXONoQKBgQDYJHhIO/VjRiP2C375
iDQ7v9lMHxuuThefiE0wblIfXz57zLMZMv4NamoaX16QB5k9QmNvd6/gx/f3iZsr
NcPZBju3eivCFx1/p/DfrnhKlWP75DQBtA3e6G2ziiU9fw6CY5wtxQ1dqmDh/KeT
5FGl1zCZtIvJGiZB7m0SAysjIQKBgQDHsH/TXJVk0cIU2f7e9NWbRHzPC7U6Iiv8
XkPhxUBzRPT+ih88yMjy3IX8osbQIwET3NL1hgLth+yusbVDXymOkmKyFEnZL3aJ
x5T7t+mj+xBC6NmX83t+3XRxK/XGmTYZnU/Je8OqdehpOmIS/TlQzsawO82ORpDQ
XP/I24fL+QKBgCTIaBPa6FLBsAMCR9SNYl48su0qahqKvahvmLtCOwWNvuNwnZYP
QH7l+jKMwln+gQyUzLk+hBbb0Q42Q8rhtnergOQjjWjVaDa+TNa0KVKAA+jtGBCm
JKonoeuo+ddyVPTJoN2FKFYlVaF/zsDzXRW8/k9aE2Pg6FvWCIfFNEUhAoGAc51E
5OLdvBmV/OyaHAw1AEiO2nE05AuU2/DX7Id/4T0ze4wMueymK7Zx/OthoHAj15Qq
r+x/FXd1GU/aWr9mGB249tG4T/6i6vKa14KLy1049QRLtyZJghJFsKB7FBjwsbPa
1hTKHI9XmFUtI0FpRdfyQWbehFlmzryJe4le/kECgYB9NWJTa47W0/KE03JI3KUQ
Ga0TPYefBTDXCGi8HzNrBBDgwsCmCgncAYc8Hb+L+YTxCvbG45eu6F/3Ym54YRNf
QjBjGRxfQX3M8mykrEcV2VD/xMGgkdwnXlqMFmE/fIPMbeA4YQ0QAfrvIZILJE+x
TzrYqGDRj7/vlxLscj4Rbw==
-----END PRIVATE KEY-----
`;
const CONNECT_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDNDCCAhygAwIBAgIULLN0aB3T8d6+sj6swhRA4veyodYwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQcHJvdmlkZXIuaW52YWxpZDAeFw0yNjEwMDEwNzU1MTda
Fw0zNjA5MjgwNzU1MTdaMBsxGTAXBgNVBAMMEHByb3ZpZGVyLmludmFsaWQwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQComV5/ZCsvuz3kWLFXGECmg4HU
M1fw9gdNjJOKf1jpupmeeG1RHwaI0CM+hdhVbzwUPKd9s8dU/y4ojl9enwSuuu5y
pPzxlnkCBje1xGL3XHw4KGE+F6ytyZFu2/3649GqYW8lzuFIvcPEgzshEYa/3mil
iQz1Xyb77X9gjHXZawnokOM+Ci6lLHwvS7K4/hOUVWT43HcFdKzcxEoiktcuSAm/
klImsZodxwUy9V+E+PXzz0aDhyLOb1PfYmycPUY5WTUSl14+/iSB01/hCqQ0lua8
SsxNQyTxe7CpBvhX+dyBFY8PNHIayW6CcKSENUmsgbxnRg2hXgAoQp0LN1YZAgMB
AAGjcDBuMB0GA1UdDgQWBBQhSN1Ow2MLml8BFyHRvnqsomeSrzAfBgNVHSMEGDAW
gBQhSN1Ow2MLml8BFyHRvnqsomeSrzAPBgNVHRMBAf8EBTADAQH/MBsGA1UdEQQU
MBKCEHByb3ZpZGVyLmludmFsaWQwDQYJKoZIhvcNAQELBQADggEBAHyHZiTYdiZK
4FholNf4qw+HnXB9gtAP99G8fa6Go5nYXAmfn+gvDTyPHvKhH8b/GdNG+ivHqPlX
i8ilvMmPETic/k75Ub4uKiijLLe+bm8eOU/1qPhsnXgzRlGXPqcTSI1bvnqTFSoW
TnFR4JSLQ51gQGf8SQhv13QTrsp1rB1g3Y/ILkzX5oO0AtdS4GUp8PSYCHl4/z5f
uXdlwwa+MHGng49TJtMQsLnwDPHnrzvCdifWru1PZKFVfTGXd57oYKAtbAA9Bx50
ggFE7DhPHh4yy4ZA1DjAy4+Ik5CbFknSS/sb/Gfy82UguZvmz78XpqN94B3m+1tC
Jp8uW4O2VDU=
-----END CERTIFICATE-----
`;
