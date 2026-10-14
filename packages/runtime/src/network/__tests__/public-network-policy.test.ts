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
import dns from 'node:dns/promises';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { test, type TestContext } from 'node:test';
import { withTimeout } from '@maka/core/test-only/async-primitives';
import {
  createProxiedFetchTransport,
  PublicNetworkPolicyError,
} from '../scoped-fetch-transport.js';
import { preparePublicNetworkTarget } from '../public-network-policy.js';

const policy = { targetPolicy: 'public', redirect: 'manual' } as const;
function restore(t: TestContext) {
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  syncBuiltinESMExports();
}

test('public policy is per request; ordinary private requests and automatic redirects still work', async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === '/redirect') res.writeHead(302, { location: '/image' }).end();
    else res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const transport = createProxiedFetchTransport(null);
  try {
    assert.equal(await (await transport.fetch(url + '/redirect')).text(), 'ok');
    await assert.rejects(transport.fetch(url, policy), PublicNetworkPolicyError);
    assert.equal(hits, 2);
    assert.equal(await (await transport.fetch(url)).text(), 'ok');
    assert.equal(hits, 3);
    await assert.rejects(
      transport.fetch('http://image.example', { targetPolicy: 'public' }),
      /manual redirects/,
    );
  } finally {
    await transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const address of ['198.18.0.2', '198.19.255.254', '2001:2::6', '2001:2:0:1::2']) {
  test(`public policy rejects benchmark DNS and literal ${address} without exceptions`, async (t) => {
    const benchmark = { address, family: address.includes(':') ? 6 : 4 };
    let answers = [benchmark];
    const lookup = t.mock.method(dns, 'lookup', async () => answers);
    const connect = t.mock.method(net, 'connect', () =>
      assert.fail('blocked target reached transport'),
    );
    restore(t);
    const direct = createProxiedFetchTransport(null);
    const proxy = createProxiedFetchTransport({
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: 1,
      bypassList: [],
    });
    try {
      for (const resolved of [[benchmark], [{ address: '93.184.216.34', family: 4 }, benchmark]]) {
        answers = resolved;
        await assert.rejects(
          direct.fetch('http://image.example', policy),
          PublicNetworkPolicyError,
        );
      }
      assert.equal(lookup.mock.callCount(), 2);
      const literal = `http://${benchmark.family === 6 ? `[${address}]` : address}/`;
      for (const transport of [direct, proxy]) {
        await assert.rejects(transport.fetch(literal, policy), PublicNetworkPolicyError);
      }
      assert.equal(lookup.mock.callCount(), 2);
      assert.equal(connect.mock.callCount(), 0);
    } finally {
      await direct.close();
      await proxy.close();
    }
  });
}

test('public policy rejects local names and private literals before DNS on either route', async (t) => {
  const lookup = t.mock.method(dns, 'lookup', async () => assert.fail('forbidden URL reached DNS'));
  restore(t);
  for (const proxy of [
    null,
    { enabled: true, type: 'http' as const, host: '127.0.0.1', port: 1, bypassList: [] },
  ]) {
    const transport = createProxiedFetchTransport(proxy);
    try {
      for (const url of [
        'http://127.0.0.1',
        'http://0x7f000001',
        'http://10.0.0.1',
        'http://192.168.0.1',
        'http://169.254.169.254',
        'http://100.64.0.1',
        'http://[::1]',
        'http://[::ffff:127.0.0.1]',
        'http://[fd00::1]',
        'http://localhost.',
        'http://router.lan',
        'http://metadata.goog',
        'http://user:password@image.example',
        'file:///tmp/image.png',
      ]) {
        await assert.rejects(transport.fetch(url, policy), PublicNetworkPolicyError);
      }
    } finally {
      await transport.close();
    }
  }
  assert.equal(lookup.mock.callCount(), 0);
});

test('public direct requests pin admitted DNS, isolate ordinary sockets, and recheck each request', async (t) => {
  let hits = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers.host, 'image.example');
    hits++;
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const realConnect = net.connect;
  let answers = [{ address: '93.184.216.34', family: 4 }];
  const lookup = t.mock.method(dns, 'lookup', async () => answers);
  let pinnedConnections = 0;
  t.mock.method(net, 'connect', (options: net.TcpNetConnectOpts) => {
    assert.equal(options.host, 'image.example');
    if (options.lookup) {
      pinnedConnections++;
      // A fresh lookup would now resolve privately. The connector must use
      // the admitted answer, not re-resolve or reuse an ordinary socket.
      answers = [{ address: '127.0.0.1', family: 4 }];
      options.lookup(options.host, { all: true }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
      });
      options.lookup(options.host, {}, (error, address, family) => {
        assert.equal(error, null);
        assert.equal(address, '93.184.216.34');
        assert.equal(family, 4);
      });
    }
    return realConnect({ host: '127.0.0.1', port });
  });
  restore(t);
  const transport = createProxiedFetchTransport(null);
  try {
    assert.equal(await (await transport.fetch('http://image.example')).text(), 'ok');
    const mutableUrl = new URL('http://image.example');
    const checked = transport.fetch(mutableUrl, policy);
    mutableUrl.hostname = '127.0.0.1';
    assert.equal(await (await checked).text(), 'ok');
    assert.equal(pinnedConnections, 1);
    assert.equal(lookup.mock.callCount(), 1);
    await assert.rejects(transport.fetch('http://image.example', policy), PublicNetworkPolicyError);
    assert.equal(hits, 2);
    // The policy on the previous requests did not alter this transport's default.
    assert.equal(await (await transport.fetch('http://image.example')).text(), 'ok');
  } finally {
    await transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('proxy bypass applies public DNS checks only to the direct route', async (t) => {
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  const connect = t.mock.method(net, 'connect', () => assert.fail('blocked bypass reached socket'));
  restore(t);
  const transport = createProxiedFetchTransport({
    enabled: true,
    type: 'http',
    host: '127.0.0.1',
    port: 1,
    bypassList: ['image.example'],
  });
  try {
    await assert.rejects(transport.fetch('http://image.example', policy), PublicNetworkPolicyError);
    assert.equal(lookup.mock.callCount(), 1);
    assert.equal(connect.mock.callCount(), 0);
  } finally {
    await transport.close();
  }
});

for (const cancel of ['request', 'transport'] as const) {
  test(`public DNS lookup is interruptible by ${cancel} cancellation`, async (t) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (addresses: { address: string; family: number }[]) => void;
    t.mock.method(dns, 'lookup', () => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const connect = t.mock.method(net, 'connect', () => assert.fail('canceled DNS reached socket'));
    restore(t);
    const transport = createProxiedFetchTransport(null);
    const controller = new AbortController();
    const pending = assert.rejects(
      transport.fetch('http://image.example', { ...policy, signal: controller.signal }),
      /stopped|transport closed/,
    );
    try {
      await started;
      if (cancel === 'request') controller.abort(new Error('stopped'));
      else await transport.close();
      await withTimeout(pending, 1000, 'DNS cancellation did not settle');
      finish([{ address: '93.184.216.34', family: 4 }]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(connect.mock.callCount(), 0);
    } finally {
      await transport.close();
    }
  });
}

test('public DNS validation cleans abort listeners on success and failure', async (t) => {
  let answers = [{ address: '2606:4700:4700::1111', family: 6 }];
  t.mock.method(dns, 'lookup', async () => answers);
  restore(t);
  const controller = new AbortController();
  assert.deepEqual(
    await preparePublicNetworkTarget(new URL('https://image.example'), false, controller.signal),
    answers[0],
  );
  answers = [];
  await assert.rejects(
    preparePublicNetworkTarget(new URL('https://image.example'), false, controller.signal),
    PublicNetworkPolicyError,
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const cancel of ['request', 'transport'] as const) {
  test(`public direct TLS handshake preserves SNI and closes on ${cancel} cancellation`, async (t) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => {
        sockets.delete(socket);
        disconnected();
      });
      socket.once('data', (chunk) => {
        assert.equal(chunk[0], 22, 'expected a real TLS ClientHello');
        entered();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const realConnect = tls.connect;
    t.mock.method(dns, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
    t.mock.method(
      tls,
      'connect',
      (options: tls.ConnectionOptions & { lookup?: net.TcpNetConnectOpts['lookup'] }) => {
        assert.equal(options.host, 'image.example');
        assert.equal(options.servername, 'image.example');
        assert.notEqual(options.rejectUnauthorized, false);
        assert.ok(options.lookup);
        options.lookup(options.host!, { all: true }, (error, addresses) => {
          assert.equal(error, null);
          assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
        });
        return realConnect({ ...options, host: '127.0.0.1', port, lookup: undefined });
      },
    );
    restore(t);
    const transport = createProxiedFetchTransport(null);
    const controller = new AbortController();
    const pending = assert.rejects(
      transport.fetch('https://image.example', { ...policy, signal: controller.signal }),
    );
    try {
      await withTimeout(started, 2000, 'TLS handshake did not start');
      if (cancel === 'request') controller.abort();
      else await transport.close();
      await withTimeout(pending, 1000, 'fetch did not stop');
      await withTimeout(closed, 1000, 'TLS socket survived cancellation');
    } finally {
      await transport.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
