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
import { mkdtemp } from 'node:fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  request as httpRequest,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { generateTotpSecret, hashSecret, toBase32, totpAt } from '../../web-access/crypto.js';
import { saveWebAccess, type WebAccessFile } from '../../web-access/store.js';
import { attachWebGateway } from '../attach.js';

const PASSPHRASE = 'twelve chars!!';
const DISK_TOKEN = 'DISK_TOKEN';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  return address.port;
}

async function closeServer(server: Server | WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => (err ? reject(err) : resolve()));
  });
}

async function call(opts: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(first, 'expected Set-Cookie');
  return first;
}

function sessionValue(setCookie: string): string {
  const match = /(?:^|,\s*)maka_web_session=([^;]+)/.exec(setCookie);
  assert.ok(match?.[1], 'expected maka_web_session cookie');
  return match[1];
}

function upgrade(url: string, headers?: Record<string, string>): Promise<{ status: number; socket?: WebSocket }> {
  return new Promise((resolve, reject) => {
    const origin = headers?.Origin ?? headers?.origin;
    const ws = new WebSocket(url, { headers, origin });
    let settled = false;
    const timer = setTimeout(() => {
      ws.terminate();
      if (!settled) reject(new Error(`upgrade timeout for ${url}`));
    }, 5000);
    const finish = (result: { status: number; socket?: WebSocket }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      finish({ status });
      ws.terminate();
    });
    ws.on('open', () => finish({ status: 101, socket: ws }));
    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

test('attachWebGateway: login cookie, /bridge proxy, ignore URL token', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-web-gateway-'));
  const webAccessPath = join(dir, 'web-access.json');
  const secret = generateTotpSecret();
  const file: WebAccessFile = {
    version: 1,
    enabled: true,
    passphrase: await hashSecret(PASSPHRASE),
    totpSecret: toBase32(secret),
    recovery: [],
    totpConfirmed: true,
  };
  await saveWebAccess(webAccessPath, file);

  const seenUpstreamUrls: string[] = [];
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(() => {
    for (const client of upstream.clients) client.terminate();
    return closeServer(upstream);
  });
  await new Promise<void>((resolve) => upstream.once('listening', resolve));
  const bridgePort = (upstream.address() as { port: number }).port;
  upstream.on('connection', (socket, req) => {
    seenUpstreamUrls.push(req.url ?? '');
    socket.send('upstream-ok');
  });

  const server = createServer();
  t.after(() => {
    server.closeAllConnections();
    return closeServer(server);
  });
  attachWebGateway(server, {
    webAccessPath,
    bridgeToken: DISK_TOKEN,
    bridgePort,
    secureCookies: false,
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;

  const missingOrigin = await call({
    port,
    method: 'POST',
    path: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `passphrase=${encodeURIComponent(PASSPHRASE)}`,
  });
  assert.equal(missingOrigin.status, 403);

  const missingOtp = await call({
    port,
    method: 'POST',
    path: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: origin,
    },
    body: `passphrase=${encodeURIComponent(PASSPHRASE)}`,
  });
  assert.equal(missingOtp.status, 401);
  assert.deepEqual(JSON.parse(missingOtp.body), { error: 'Could not sign in' });
  assert.equal(missingOtp.headers['set-cookie'], undefined);

  const now = Math.floor(Date.now() / 1000);
  const otp = totpAt(secret, now, { digits: 6, period: 30 });
  const signedIn = await call({
    port,
    method: 'POST',
    path: '/login',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      Origin: origin,
    },
    body: `passphrase=${encodeURIComponent(PASSPHRASE)}&otp=${encodeURIComponent(otp)}`,
  });
  assert.equal(signedIn.status, 303);
  const setCookie = cookieHeader(signedIn.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/i);
  const session = sessionValue(setCookie);
  assert.notEqual(session, DISK_TOKEN);
  assert.equal(setCookie.includes(DISK_TOKEN), false);

  const anonymousHome = await call({ port, method: 'GET', path: '/' });
  assert.equal(anonymousHome.status, 303);
  assert.equal(anonymousHome.headers.location, '/login');

  const noCookieBridge = await upgrade(`ws://127.0.0.1:${port}/bridge`);
  noCookieBridge.socket?.terminate();
  assert.equal(noCookieBridge.status, 401);

  const missingUpgradeOrigin = await upgrade(`ws://127.0.0.1:${port}/bridge`, {
    Cookie: `maka_web_session=${session}`,
  });
  missingUpgradeOrigin.socket?.terminate();
  assert.equal(missingUpgradeOrigin.status, 403);

  const otherTailnet = await upgrade(`ws://127.0.0.1:${port}/bridge`, {
    Cookie: `maka_web_session=${session}`,
    Origin: 'https://other.tail1234.ts.net',
    Host: 'maka.tail1234.ts.net',
  });
  otherTailnet.socket?.terminate();
  assert.equal(otherTailnet.status, 403);

  const proxied = await upgrade(`ws://127.0.0.1:${port}/bridge`, {
    Cookie: `maka_web_session=${session}`,
    Origin: origin,
  });
  t.after(() => proxied.socket?.terminate());
  assert.equal(proxied.status, 101);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upstream did not see the disk token')), 2000);
    const check = () => {
      if (seenUpstreamUrls.length > 0) {
        clearTimeout(timer);
        resolve();
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
  assert.equal(seenUpstreamUrls[0], `/?token=${DISK_TOKEN}`);
  assert.equal(seenUpstreamUrls[0]?.includes(session), false);

  const stolen = await call({ port, method: 'GET', path: '/?token=stolen' });
  assert.equal(stolen.status, 303);
  assert.equal(stolen.headers.location, '/login');

  const loggedOut = await call({
    port,
    method: 'POST',
    path: '/logout',
    headers: {
      Origin: origin,
      Cookie: `maka_web_session=${session}`,
    },
  });
  assert.equal(loggedOut.status, 303);
  assert.equal(loggedOut.headers.location, '/login');

  const reused = await call({
    port,
    method: 'GET',
    path: '/',
    headers: { Cookie: `maka_web_session=${session}` },
  });
  assert.equal(reused.status, 303);
  assert.equal(reused.headers.location, '/login');
});

test('GET / is gated even when web-access.json is missing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-web-gateway-empty-'));
  const server = createServer();
  t.after(() => {
    server.closeAllConnections();
    return closeServer(server);
  });
  attachWebGateway(server, {
    webAccessPath: join(dir, 'missing.json'),
    bridgeToken: '',
    bridgePort: 1,
    secureCookies: false,
  });
  const port = await listen(server);
  const home = await call({ port, method: 'GET', path: '/' });
  assert.equal(home.status, 303);
  assert.equal(home.headers.location, '/login');
  const login = await call({ port, method: 'GET', path: '/login' });
  assert.equal(login.status, 200);
  assert.match(login.body, /Settings → Web access/);
  assert.match(String(login.headers['content-security-policy'] ?? ''), /frame-ancestors 'none'/);
});
