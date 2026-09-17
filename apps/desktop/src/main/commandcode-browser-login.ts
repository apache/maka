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

/**
 * Browser-assisted Command Code sign-in: the loopback flow the official
 * `command-code login` CLI performs, driven from the Desktop main process.
 *
 * This is not OAuth. Studio (commandcode.ai) opens on an approval page whose
 * `callback` query names a loopback URL this module is listening on. When the
 * user approves, the Studio page POSTs a freshly minted **API key** to that
 * URL as JSON — the same kind of key a user would paste by hand. The flow
 * therefore ends with plain credentials the renderer drops into the ordinary
 * key field; nothing downstream (creation, credential vault, discovery) knows
 * the key arrived this way.
 *
 * Why main and not the Runtime Host: the browser posts to `localhost`, so the
 * listener must share a machine with the browser. The Host may be remote; the
 * Desktop never is.
 *
 * Protocol facts (mirrored from the CLI, no public specification):
 *   GET  {studio}/studio/auth/cli?callback=http://localhost:{port}/callback&state={state}
 *   POST http://localhost:{port}/callback
 *        { apiKey, state, userId, userName, keyName }     — approved
 *        { error: 'access_denied', error_description?, state } — denied
 * The CLI walks ports from 5959 upward; Studio may check the callback port,
 * so this module keeps the same range instead of an ephemeral one.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

export const COMMANDCODE_LOGIN_TIMEOUT_MS = 120_000;
export const COMMANDCODE_LOGIN_START_PORT = 5959;
export const COMMANDCODE_LOGIN_MAX_PORT_ATTEMPTS = 10;
/** Cap on the callback body, in wire bytes (not JS string length). */
export const COMMANDCODE_LOGIN_BODY_LIMIT_BYTES = 10_000;
export const COMMANDCODE_LOGIN_ALLOWED_ORIGINS: readonly string[] = [
  'https://commandcode.ai',
  'https://staging.commandcode.ai',
  'http://localhost:3000',
];

const CALLBACK_PATH = '/callback';
const STUDIO_AUTH_PATH = '/studio/auth/cli';
const DEFAULT_STUDIO_BASE = 'https://commandcode.ai';

export type CommandCodeBrowserLoginFailureReason =
  /** Studio reported the user denied the authorization. */
  | 'denied'
  /** No callback arrived within the login window. */
  | 'timeout'
  /** Cancelled by the user or torn down with the app. */
  | 'cancelled'
  /** A newer attempt replaced this one, or the attempt id is unknown/spent. */
  | 'superseded'
  /** No loopback port in the CLI's range could be bound. */
  | 'port_unavailable'
  /** The system browser could not be opened. */
  | 'browser_unavailable';

export interface CommandCodeBrowserLoginCredentials {
  readonly apiKey: string;
  readonly userName: string;
  readonly keyName: string;
}

export interface CommandCodeBrowserLoginStartInput {
  /** The connection's Provider API base; picks the Studio that mints its keys. */
  readonly baseUrl?: string;
}

export type CommandCodeBrowserLoginStartResult =
  | {
      readonly ok: true;
      readonly attemptId: string;
      /** The approval page, for a "browser did not open?" fallback link. */
      readonly authUrl: string;
    }
  | {
      readonly ok: false;
      readonly reason: Extract<
        CommandCodeBrowserLoginFailureReason,
        'port_unavailable' | 'browser_unavailable' | 'superseded'
      >;
    };

export type CommandCodeBrowserLoginResult =
  | { readonly ok: true; readonly credentials: CommandCodeBrowserLoginCredentials }
  | { readonly ok: false; readonly reason: CommandCodeBrowserLoginFailureReason };

export interface CommandCodeBrowserLoginDeps {
  openExternal(url: string): Promise<unknown>;
  timeoutMs?: number;
  startPort?: number;
  maxPortAttempts?: number;
  randomToken?: (byteLength: number) => string;
}

/** Studio host that mints keys for a given Provider API base. */
export function studioBaseForApiBase(apiBase: string | undefined): string {
  if (apiBase === undefined) return DEFAULT_STUDIO_BASE;
  if (/^https:\/\/staging-api\.commandcode\.ai(?:[/:]|$)/iu.test(apiBase)) {
    return 'https://staging.commandcode.ai';
  }
  if (/^http:\/\/localhost(?::\d+)?(?:\/|$)/iu.test(apiBase)) return 'http://localhost:3000';
  return DEFAULT_STUDIO_BASE;
}

export function buildCommandCodeAuthUrl(input: {
  studioBase: string;
  port: number;
  state: string;
}): string {
  const callback = `http://localhost:${input.port}${CALLBACK_PATH}`;
  const url = new URL(STUDIO_AUTH_PATH, input.studioBase);
  url.searchParams.set('callback', callback);
  url.searchParams.set('state', input.state);
  return url.toString();
}

interface Attempt {
  readonly id: string;
  readonly state: string;
  port: number;
  server: Server | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly settled: Promise<CommandCodeBrowserLoginResult>;
  settle: ((result: CommandCodeBrowserLoginResult) => void) | undefined;
  /** `complete()` hands the result out once; a second read is spent. */
  delivered: boolean;
}

export class CommandCodeBrowserLoginController {
  readonly #deps: CommandCodeBrowserLoginDeps;
  readonly #attempts = new Map<string, Attempt>();
  #current: Attempt | undefined;
  #disposed = false;

  constructor(deps: CommandCodeBrowserLoginDeps) {
    this.#deps = deps;
  }

  /**
   * Binds the loopback listener, opens the Studio approval page, and returns
   * the attempt handle. A live attempt is superseded: one browser tab at a
   * time, and its dead port must never be handed back as a fresh link.
   */
  async start(
    input: CommandCodeBrowserLoginStartInput = {},
  ): Promise<CommandCodeBrowserLoginStartResult> {
    if (this.#disposed) return { ok: false, reason: 'browser_unavailable' };
    // Reserved before the first await. Binding a port is asynchronous, so a
    // second start() that ran the supersession check first would see no
    // current attempt, bind a second port beside this one, and leave two live
    // attempts each able to deliver its own credentials.
    const attempt = this.#reserve();

    const bound = await this.#bind(attempt);
    if (!bound) {
      this.#finish(attempt, { ok: false, reason: 'port_unavailable' });
      return { ok: false, reason: 'port_unavailable' };
    }
    // A newer start (or a cancel, or dispose) retired this attempt while it
    // was binding. Its result has already settled; the port it just took is
    // held by nobody, so release it here.
    if (attempt.settle === undefined || this.#disposed) {
      this.#finish(attempt, { ok: false, reason: 'superseded' });
      return { ok: false, reason: 'superseded' };
    }

    const authUrl = buildCommandCodeAuthUrl({
      studioBase: studioBaseForApiBase(input.baseUrl),
      port: attempt.port,
      state: attempt.state,
    });
    attempt.timer = setTimeout(
      () => this.#finish(attempt, { ok: false, reason: 'timeout' }),
      this.#deps.timeoutMs ?? COMMANDCODE_LOGIN_TIMEOUT_MS,
    );
    attempt.timer.unref?.();

    try {
      await this.#deps.openExternal(authUrl);
    } catch {
      this.#finish(attempt, { ok: false, reason: 'browser_unavailable' });
      return { ok: false, reason: 'browser_unavailable' };
    }
    // The browser may already have posted back while openExternal was
    // pending; `complete()` reads the settled result either way.
    return { ok: true, attemptId: attempt.id, authUrl };
  }

  /**
   * Resolves when the attempt settles: approved, denied, timed out,
   * cancelled, or replaced. The credentials are delivered exactly once.
   */
  async complete(attemptId: string): Promise<CommandCodeBrowserLoginResult> {
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined || attempt.delivered) return { ok: false, reason: 'superseded' };
    attempt.delivered = true;
    const result = await attempt.settled;
    this.#attempts.delete(attemptId);
    return result;
  }

  cancel(attemptId?: string): void {
    const attempt = attemptId === undefined ? this.#current : this.#attempts.get(attemptId);
    if (attempt === undefined) return;
    this.#finish(attempt, { ok: false, reason: 'cancelled' });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#finish(this.#current, { ok: false, reason: 'cancelled' });
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /** Retires the live attempt and installs a fresh one, without awaiting. */
  #reserve(): Attempt {
    let settle!: (result: CommandCodeBrowserLoginResult) => void;
    const settled = new Promise<CommandCodeBrowserLoginResult>((resolve) => {
      settle = resolve;
    });
    const attempt: Attempt = {
      id: randomUUID(),
      state: this.#deps.randomToken?.(32) ?? randomBytes(32).toString('base64url'),
      port: 0,
      server: undefined,
      timer: undefined,
      settled,
      settle,
      delivered: false,
    };
    this.#finish(this.#current, { ok: false, reason: 'superseded' });
    this.#current = attempt;
    this.#attempts.set(attempt.id, attempt);
    return attempt;
  }

  async #bind(attempt: Attempt): Promise<boolean> {
    const startPort = this.#deps.startPort ?? COMMANDCODE_LOGIN_START_PORT;
    const attempts = this.#deps.maxPortAttempts ?? COMMANDCODE_LOGIN_MAX_PORT_ATTEMPTS;
    for (let index = 0; index < attempts; index += 1) {
      const port = startPort + index;
      const server = await listenLoopback(port, (request, response) =>
        this.#handleCallback(attempt, request, response),
      );
      if (server === undefined) continue;
      attempt.server = server;
      attempt.port = port;
      return true;
    }
    return false;
  }

  #handleCallback(attempt: Attempt, request: IncomingMessage, response: ServerResponse): void {
    // One-shot responses: the server dies with the attempt, and a client
    // pooling the connection would otherwise race its next request against
    // the close.
    response.setHeader('Connection', 'close');
    response.setHeader('Access-Control-Allow-Origin', corsOrigin(request.headers.origin));
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    const json = (code: number, body: Record<string, unknown>) => {
      response.writeHead(code);
      response.end(JSON.stringify(body));
    };

    // DNS-rebinding defense shared with this repo's other loopback listeners:
    // only a request addressed to the loopback authority we bound may proceed.
    const host = request.headers.host;
    if (host !== `localhost:${attempt.port}` && host !== `127.0.0.1:${attempt.port}`) {
      json(403, { success: false, error: 'Forbidden' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const path = request.url?.split('?')[0] ?? '/';
    if (path !== CALLBACK_PATH) {
      json(404, { success: false, error: 'Not found' });
      return;
    }
    if (request.method !== 'POST') {
      json(405, { success: false, error: 'Method not allowed. Use POST.' });
      return;
    }

    let bodyBytes = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
      if (bodyBytes > COMMANDCODE_LOGIN_BODY_LIMIT_BYTES) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      // A destroyed (over-limit) request never processes its partial body.
      if (request.destroyed) return;
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        json(400, { success: false, error: 'Invalid JSON' });
        return;
      }
      if (!isRecord(payload)) {
        json(400, { success: false, error: 'Invalid JSON' });
        return;
      }
      // State FIRST, on every branch. A denial is terminal, and the Studio
      // page's POST rides as a CORS simple request the browser sends
      // regardless of our origin allowlist — so without this order any web
      // page could kill a live login by blindly posting `access_denied`.
      if (payload.state !== attempt.state) {
        // Not terminal: a stale tab replaying an old state must not end the
        // live attempt. Answer and keep waiting, as the CLI does.
        json(403, { success: false, error: 'Invalid state token' });
        return;
      }
      if ('error' in payload) {
        json(200, { success: true });
        this.#finish(attempt, { ok: false, reason: 'denied' });
        return;
      }
      const credentials = readCredentials(payload);
      if (credentials === undefined) {
        json(400, { success: false, error: 'Missing required fields' });
        return;
      }
      json(200, { success: true });
      this.#finish(attempt, { ok: true, credentials });
    });
    request.on('error', () => {});
  }

  #finish(attempt: Attempt | undefined, result: CommandCodeBrowserLoginResult): void {
    if (attempt === undefined) return;
    if (attempt.timer !== undefined) {
      clearTimeout(attempt.timer);
      attempt.timer = undefined;
    }
    if (attempt.server !== undefined) {
      const server = attempt.server;
      attempt.server = undefined;
      server.close();
      // The callback response has been flushed by the time we get here; a
      // lingering keep-alive socket must not hold the CLI port range.
      server.closeAllConnections();
    }
    if (this.#current === attempt) this.#current = undefined;
    const settle = attempt.settle;
    attempt.settle = undefined;
    settle?.(result);
  }
}

function listenLoopback(
  port: number,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.once('error', () => resolve(undefined));
    server.listen(port, '127.0.0.1', () => {
      server.removeAllListeners('error');
      // A bound server that later errors must not crash the process.
      server.on('error', () => {});
      resolve(server);
    });
  });
}

function corsOrigin(origin: string | undefined): string {
  return origin !== undefined && COMMANDCODE_LOGIN_ALLOWED_ORIGINS.includes(origin) ? origin : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCredentials(
  payload: Record<string, unknown>,
): CommandCodeBrowserLoginCredentials | undefined {
  const { apiKey, userName, keyName } = payload;
  if (typeof apiKey !== 'string' || apiKey === '') return undefined;
  if (typeof userName !== 'string' || typeof keyName !== 'string') return undefined;
  return { apiKey, userName, keyName };
}
