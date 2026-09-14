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

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { loadWebAccess, saveWebAccess } from '../web-access/store.js';
import { LOGIN_CSP, loginPageHtml } from './login-page.js';
import { isAllowedWebOrigin } from './origin.js';
import {
  createSessionTable,
  expireCookieHeader,
  lookupSession,
  parseCookie,
  sessionCookieHeader,
  type SessionTable,
  verifyLogin,
} from './session.js';

export interface AttachWebGatewayOptions {
  webAccessPath: string;
  bridgeToken: string;
  bridgePort: number;
  secureCookies: boolean;
}

const SIGN_IN_ERROR = { error: 'Could not sign in' };
const BODY_LIMIT = 64 * 1024;

export function attachWebGateway(server: Server, options: AttachWebGatewayOptions): void {
  const table = createSessionTable();
  const wss = new WebSocketServer({ noServer: true });

  interceptRequest(server, (req, res, next) => {
    if (!ownsHttp(req, table)) {
      next();
      return;
    }
    void handleHttp(req, res, options, table);
  });

  interceptUpgrade(server, (req, socket, head, next) => {
    if (requestPath(req.url) !== '/bridge') {
      next();
      return;
    }
    handleBridgeUpgrade(req, socket, head, options, table, wss);
  });

  server.on('close', () => {
    wss.close();
  });
}

export function needsSession(url: string | undefined): boolean {
  const path = requestPath(url);
  if (path === '/login' || path === '/logout') return false;
  if (
    path.startsWith('/@vite') ||
    path.startsWith('/@id') ||
    path.startsWith('/@fs') ||
    path.startsWith('/node_modules') ||
    path.startsWith('/.vite')
  ) {
    return false;
  }
  return true;
}

function ownsHttp(req: IncomingMessage, table: SessionTable): boolean {
  const path = requestPath(req.url);
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' && path === '/login') return true;
  if (method === 'POST' && (path === '/login' || path === '/logout')) return true;
  if (!needsSession(req.url)) return false;
  return !hasValidSession(req, table);
}

function hasValidSession(req: IncomingMessage, table: SessionTable): boolean {
  const token = parseCookie(cookieHeader(req));
  if (!token) return false;
  return lookupSession(table, token, Math.floor(Date.now() / 1000));
}

function cookieHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers.cookie;
  return Array.isArray(raw) ? raw.join('; ') : raw;
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: AttachWebGatewayOptions,
  table: SessionTable,
): Promise<void> {
  const path = requestPath(req.url);
  const method = (req.method ?? 'GET').toUpperCase();
  try {
    if (method === 'GET' && path === '/login') {
      writeLogin(res, hasLoginError(req.url));
      return;
    }
    if (method === 'POST' && path === '/login') {
      await handleLogin(req, res, options, table);
      return;
    }
    if (method === 'POST' && path === '/logout') {
      if (!allowOrigin(req, res)) return;
      writeRedirect(res, 303, '/login', {
        'Set-Cookie': expireCookieHeader({ secure: options.secureCookies }),
      });
      return;
    }
    if (isHtmlNavigation(req, path)) writeRedirect(res, 303, '/login');
    else writeJson(res, 401, SIGN_IN_ERROR);
  } catch {
    if (!res.headersSent) writeJson(res, 500, SIGN_IN_ERROR);
  }
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  options: AttachWebGatewayOptions,
  table: SessionTable,
): Promise<void> {
  if (!allowOrigin(req, res)) return;
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    writeJson(res, 413, SIGN_IN_ERROR);
    return;
  }
  let passphrase = '';
  let otp = '';
  try {
    ({ passphrase, otp } = parseCredentials(req.headers['content-type'], body));
  } catch {
    writeJson(res, 400, SIGN_IN_ERROR);
    return;
  }

  const file = await loadWebAccess(options.webAccessPath);
  if (!file) {
    writeJson(res, 401, SIGN_IN_ERROR);
    return;
  }

  const result = await verifyLogin({
    file,
    passphrase,
    otp,
    now: Math.floor(Date.now() / 1000),
    table,
    clientAddress: req.socket.remoteAddress ?? '0.0.0.0',
  });
  if (!result.ok) {
    if (result.reason === 'lockout') {
      writeJson(res, 429, SIGN_IN_ERROR, { 'Retry-After': String(result.retryAfterSec) });
      return;
    }
    writeJson(res, 401, SIGN_IN_ERROR);
    return;
  }
  if (result.recoveryRemaining) {
    await saveWebAccess(options.webAccessPath, { ...file, recovery: result.recoveryRemaining });
  }
  writeRedirect(res, 303, '/', {
    'Set-Cookie': sessionCookieHeader(result.token, { secure: options.secureCookies }),
  });
}

function handleBridgeUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: AttachWebGatewayOptions,
  table: SessionTable,
  wss: WebSocketServer,
): void {
  if (!hasValidSession(req, table)) {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }
  const origin = req.headers.origin;
  if (origin && !isAllowedWebOrigin(origin)) {
    rejectUpgrade(socket, 403, 'Forbidden');
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(
      `ws://127.0.0.1:${options.bridgePort}/?token=${encodeURIComponent(options.bridgeToken)}`,
    );
    pipeSockets(client, upstream);
  });
}

function pipeSockets(client: WebSocket, upstream: WebSocket): void {
  const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      pending.push({ data, binary: isBinary });
    }
  });
  upstream.on('open', () => {
    for (const item of pending) {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(item.data, { binary: item.binary });
    }
    pending.length = 0;
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  const closePeer = (from: WebSocket, to: WebSocket) => {
    from.on('close', () => {
      if (to.readyState === WebSocket.OPEN) to.close();
      else if (to.readyState === WebSocket.CONNECTING) to.terminate();
    });
    from.on('error', () => {
      try {
        to.terminate();
      } catch {
        // Best-effort teardown of the other hop.
      }
    });
  };
  closePeer(client, upstream);
  closePeer(upstream, client);
}

function rejectUpgrade(socket: Duplex, code: number, message: string): void {
  try {
    socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // Socket already gone.
  }
  socket.destroy();
}

function allowOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (isAllowedWebOrigin(origin)) return true;
  writeJson(res, 403, SIGN_IN_ERROR);
  return false;
}

function isHtmlNavigation(req: IncomingMessage, path: string): boolean {
  if (path === '/' || path === '/index.html') return true;
  const accept = req.headers.accept ?? '';
  if (accept.includes('text/html')) return true;
  return req.headers['sec-fetch-mode'] === 'navigate';
}

function hasLoginError(url: string | undefined): boolean {
  try {
    return new URL(url ?? '/', 'http://127.0.0.1').searchParams.get('e') === '1';
  } catch {
    return false;
  }
}

function requestPath(url: string | undefined): string {
  let path = '/';
  try {
    path = new URL(url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/';
  }
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

function parseCredentials(
  contentType: string | string[] | undefined,
  body: string,
): { passphrase: string; otp: string } {
  const raw = Array.isArray(contentType) ? contentType[0] : contentType;
  const type = (raw ?? '').split(';')[0]?.trim().toLowerCase();
  if (type === 'application/json') {
    const parsed = JSON.parse(body) as { passphrase?: unknown; otp?: unknown };
    return {
      passphrase: typeof parsed.passphrase === 'string' ? parsed.passphrase : '',
      otp: typeof parsed.otp === 'string' ? parsed.otp : '',
    };
  }
  const params = new URLSearchParams(body);
  return {
    passphrase: params.get('passphrase') ?? '',
    otp: params.get('otp') ?? '',
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > BODY_LIMIT) {
      req.destroy();
      throw new Error('payload-too-large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeLogin(res: ServerResponse, error: boolean): void {
  const body = Buffer.from(loginPageHtml(error), 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': LOGIN_CSP,
  });
  res.end(body);
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra?: Record<string, string | number>,
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...extra,
  });
  res.end(payload);
}

function writeRedirect(
  res: ServerResponse,
  status: number,
  location: string,
  extra?: Record<string, string>,
): void {
  res.writeHead(status, { Location: location, ...extra });
  res.end();
}

function interceptRequest(
  server: Server,
  handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void,
): void {
  const existing = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let continued = false;
    handler(req, res, () => {
      if (continued) return;
      continued = true;
      for (const listener of existing) listener.call(server, req, res);
    });
  });
}

function interceptUpgrade(
  server: Server,
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer, next: () => void) => void,
): void {
  const existing = server.listeners('upgrade') as Array<
    (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  >;
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req, socket, head) => {
    let continued = false;
    handler(req, socket, head, () => {
      if (continued) return;
      continued = true;
      for (const listener of existing) listener.call(server, req, socket, head);
    });
  });
}
