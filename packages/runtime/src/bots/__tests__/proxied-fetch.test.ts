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
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import net from 'node:net';
import { PROXY_DEFAULTS } from '@maka/core/settings/network-settings';
import { setActiveProxy } from '../../network/active-proxy-state.js';
import { proxiedFetch } from '../proxied-fetch.js';

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label)), ms);
      timer.unref();
    }),
  ]);
}

// A minimal HTTP proxy that is also the fake upstream. It accepts either
// proxy request form (CONNECT tunneling, or the absolute-form forwarding
// undici's ProxyAgent uses for plain-http targets), sends the response
// headers plus the first body chunk immediately, and withholds the tail
// until the test asks for it. This keeps the streaming assertions
// event-driven instead of wall-clock-sensitive.
function startStreamingProxy(): Promise<{
  port: number;
  sendTail: () => void;
  tailSent: () => boolean;
  close: () => Promise<void>;
}> {
  const sockets = new Set<net.Socket>();
  let tailSent = false;
  let sendTailNow: () => void = () => {};
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    let buffered = '';
    let phase: 'proxy-request' | 'tunneled-request' | 'streaming' = 'proxy-request';
    const beginStreaming = () => {
      buffered = '';
      phase = 'streaming';
      socket.write(
        'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 16\r\n\r\nhello world',
      );
      sendTailNow = () => {
        tailSent = true;
        socket.write('-tail');
      };
    };
    socket.on('data', (data) => {
      buffered += data.toString('latin1');
      if (!buffered.includes('\r\n\r\n')) return;
      if (phase === 'proxy-request') {
        if (buffered.startsWith('CONNECT ')) {
          buffered = '';
          phase = 'tunneled-request';
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          return;
        }
        beginStreaming();
        return;
      }
      if (phase === 'tunneled-request') beginStreaming();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('proxy has no address'));
        return;
      }
      resolve({
        port: address.port,
        sendTail: () => sendTailNow(),
        tailSent: () => tailSent,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

describe('proxiedFetch', () => {
  test('returns a streaming proxied response at headers, before body EOF', async () => {
    const proxy = await startStreamingProxy();
    setActiveProxy({
      ...PROXY_DEFAULTS,
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: proxy.port,
      bypassList: [],
    });
    const caller = new AbortController();
    try {
      const response = await withTimeout(
        proxiedFetch('http://example.test/stream', { timeoutMs: 0, signal: caller.signal }),
        5_000,
        'proxiedFetch did not return before body EOF',
      );
      assert.equal(response.status, 200);
      assert.equal(response.url, 'http://example.test/stream');
      assert.equal(response.redirected, false);
      assert.throws(() => response.headers.set('x-review-check', 'mutable'), TypeError);
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
      assert.equal(proxy.tailSent(), false);

      assert.ok(response.body);
      const reader = response.body.getReader();
      const first = await withTimeout(reader.read(), 5_000, 'first chunk not readable before tail');
      assert.equal(Buffer.from(first.value ?? []).toString(), 'hello world');
      assert.equal(proxy.tailSent(), false);

      proxy.sendTail();
      let rest = '';
      for (;;) {
        const chunk = await withTimeout(reader.read(), 5_000, 'tail never arrived');
        if (chunk.done) break;
        rest += Buffer.from(chunk.value).toString();
      }
      assert.equal(rest, '-tail');

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    } finally {
      setActiveProxy(null);
      await proxy.close();
    }
  });

  test('cancelling the streamed body detaches the caller abort listener', async () => {
    const proxy = await startStreamingProxy();
    setActiveProxy({
      ...PROXY_DEFAULTS,
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: proxy.port,
      bypassList: [],
    });
    const caller = new AbortController();
    try {
      const response = await withTimeout(
        proxiedFetch('http://example.test/stream', { timeoutMs: 0, signal: caller.signal }),
        5_000,
        'proxiedFetch did not return before body EOF',
      );
      assert.ok(response.body);
      await response.body.cancel();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    } finally {
      setActiveProxy(null);
      await proxy.close();
    }
  });

  test('caller abort after headers still aborts the original streamed body', async () => {
    const proxy = await startStreamingProxy();
    setActiveProxy({
      ...PROXY_DEFAULTS,
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: proxy.port,
      bypassList: [],
    });
    const caller = new AbortController();
    try {
      const response = await withTimeout(
        proxiedFetch('http://example.test/stream', { timeoutMs: 0, signal: caller.signal }),
        5_000,
        'proxiedFetch did not return before body EOF',
      );
      assert.ok(response.body);
      const reader = response.body.getReader();
      const first = await withTimeout(
        reader.read(),
        5_000,
        'first chunk not readable before abort',
      );
      assert.equal(Buffer.from(first.value ?? []).toString(), 'hello world');

      caller.abort(new Error('caller stopped'));
      await assert.rejects(() => reader.read(), /caller stopped|abort/iu);
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    } finally {
      setActiveProxy(null);
      await proxy.close();
    }
  });

  test('times out and destroys stuck active proxy dispatchers', async () => {
    const sockets = new Set<net.Socket>();
    const proxy = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
      // Accept the proxy TCP connection, then never respond. This
      // exercises proxiedFetch's timeout path without relying on DNS
      // behavior for invalid hostnames.
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(0, '127.0.0.1', () => resolve());
    });
    const address = proxy.address();
    assert.ok(address && typeof address === 'object');
    setActiveProxy({
      ...PROXY_DEFAULTS,
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: address.port,
    });
    const started = Date.now();

    try {
      await assert.rejects(
        () => proxiedFetch('http://example.com', { timeoutMs: 100 }),
        /timeout/i,
      );
      assert.ok(Date.now() - started < 2_000);
    } finally {
      setActiveProxy(null);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  test('timeoutMs 0 disables the internal timeout for streaming callers', async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }, 40);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    try {
      const response = await proxiedFetch(`http://127.0.0.1:${address.port}`, { timeoutMs: 0 });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
