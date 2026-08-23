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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { expect } from '../../test-helpers.js';
import { PROXY_DEFAULTS } from '@maka/core/settings/network-settings';
import { testProxyConnection } from '../proxy-test.js';

describe('testProxyConnection', () => {
  test('returns an error when the proxy host refuses connections', async () => {
    const result = await testProxyConnection({
      proxy: { ...PROXY_DEFAULTS, enabled: true, type: 'http', host: '127.0.0.1', port: 1 },
      url: 'http://example.com',
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.error ?? '').toMatch(/ECONNREFUSED|fetch failed|bad port|timeout/i);
  });

  test('does not depend on the ambient global fetch when using the proxy dispatcher', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));

      let buffer = '';
      let tunnelEstablished = false;
      socket.on('data', (chunk) => {
        buffer += chunk.toString('latin1');
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const requestHead = buffer.slice(0, headerEnd);
        buffer = buffer.slice(headerEnd + 4);
        if (!tunnelEstablished && requestHead.startsWith('CONNECT ')) {
          tunnelEstablished = true;
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          return;
        }

        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const originalFetch = globalThis.fetch;
    let ambientFetchCalled = false;
    globalThis.fetch = (async () => {
      ambientFetchCalled = true;
      throw new Error('ambient global fetch must not be used');
    }) as typeof globalThis.fetch;

    try {
      const result = await testProxyConnection({
        proxy: {
          ...PROXY_DEFAULTS,
          enabled: true,
          type: 'http',
          host: '127.0.0.1',
          port: address.port,
        },
        url: 'http://example.com',
        timeoutMs: 1_000,
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(ambientFetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('times out when the proxy accepts TCP but never responds', async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
      // Intentionally never write an HTTP response. This is a
      // deterministic proxy timeout fixture; DNS failures can return
      // "fetch failed" before the timeout on some machines.
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const started = Date.now();
    try {
      const result = await testProxyConnection({
        proxy: {
          ...PROXY_DEFAULTS,
          enabled: true,
          type: 'http',
          host: '127.0.0.1',
          port: address.port,
        },
        url: 'http://example.com',
        timeoutMs: 100,
      });

      expect(result.ok).toBe(false);
      expect(result.error ?? '').toMatch(/timeout|fetch failed/i);
      assert.ok(Date.now() - started < 2_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
