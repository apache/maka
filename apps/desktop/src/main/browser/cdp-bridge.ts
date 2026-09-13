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

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebContents } from 'electron';
import { WebSocket, WebSocketServer } from 'ws';
import { BRIDGE_START_TIMEOUT_MS, CDP_BRIDGE_SECRET_LENGTH } from './options.js';

export type CdpBridgeErrorCode = 'target-busy' | 'target-destroyed' | 'bridge-start-timeout';

/** Typed failure so callers branch on a code instead of matching message text. */
export class CdpBridgeError extends Error {
  constructor(
    readonly code: CdpBridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CdpBridgeError';
  }
}

type IncomingCommand = { id?: number; method?: string; params?: unknown; sessionId?: string };

export type AutomationEndpoint = { cdpEndpoint: string };

/**
 * Exposes one WebContents' CDP surface over a sealed local endpoint
 * `ws://127.0.0.1:<random-port>/<secret>`, relaying ws CDP traffic to and from
 * `webContents.debugger`. Security contract — each rule is covered by a test:
 *
 *  1. loopback only + OS-assigned random port (`listen(0, "127.0.0.1")`);
 *  2. the per-bridge secret is matched at the HTTP upgrade with a constant-time
 *     compare; a wrong secret is destroyed there and never consumes the single
 *     connection slot (so it can't be used to starve the real client);
 *  3. Host is pinned to the loopback authority and any browser `Origin` is
 *     rejected, defeating DNS rebinding;
 *  4. exactly one connection at a time;
 *  5. the secret lives only in main-process memory — never logged, never
 *     returned in errors;
 *  6. only the single WebContents passed in is attached — never the main window,
 *     never a global `--remote-debugging-port`.
 *
 * Rule 7 (endpoint/secret never leave main via renderer IPC / preload) is the
 * caller's contract: `start()` hands the endpoint back as a same-process value.
 */
export class CdpBridge {
  private http: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private port = 0;
  private started = false;
  private starting: Promise<AutomationEndpoint> | null = null;
  // Set only while listen() is pending; stop() calls it so a teardown racing a
  // start-in-flight fails the start immediately instead of letting it wait out
  // its own timeout on a server that will never come up.
  private abortListen: ((err: Error) => void) | null = null;
  // A fresh secret per start() so a reused bridge (e.g. after DevTools stole the
  // debugger) never re-serves an old path.
  private secret = '';
  private path = '';
  // Outstanding client command ids, each keyed to the connection that issued
  // it (and the CDP sessionId it was sent on): teardown can fail them
  // immediately (instead of leaving the client to wait out its own ~30s CDP
  // timeout) with a response the client can route, and a completion is only
  // delivered to its own connection — a reconnecting client reusing the same
  // ids must never receive a stale result from the previous connection.
  private readonly pending = new Map<number, { ws: WebSocket; sessionId?: string }>();

  constructor(private readonly wc: WebContents) {}

  async start(): Promise<AutomationEndpoint> {
    if (this.started) return { cdpEndpoint: this.endpointUrl() };
    // Share an in-flight start: a second caller arriving mid-start would see
    // its own bridge's freshly attached debugger and misreport target-busy.
    if (!this.starting)
      this.starting = this.doStart().finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private async doStart(): Promise<AutomationEndpoint> {
    if (this.wc.isDestroyed()) throw new CdpBridgeError('target-destroyed', 'WebContents is gone');
    // Rule 6: refuse if anything else already owns the debugger (DevTools or
    // another client) instead of fighting over it.
    if (this.wc.debugger.isAttached())
      throw new CdpBridgeError('target-busy', 'debugger is already attached to this target');

    this.secret = randomBytes(CDP_BRIDGE_SECRET_LENGTH).toString('hex');
    this.path = `/${this.secret}`;
    this.wc.debugger.attach('1.3');
    this.wc.debugger.on('message', this.onDebuggerMessage);
    this.wc.debugger.on('detach', this.onDebuggerDetach);
    // A directly destroyed WebContents is not guaranteed to emit a debugger
    // 'detach' first; without this the ws server (and its port) would leak.
    this.wc.once('destroyed', this.onDebuggerDetach);

    // The HTTP server exists only to host the ws upgrade; it never serves plain HTTP.
    const http = createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    http.on('upgrade', this.onUpgrade);
    this.http = http;
    this.wss = new WebSocketServer({ noServer: true });

    try {
      await this.listen(http);
    } catch (err) {
      await this.stop();
      throw err;
    }
    // stop() may have intervened after listen already succeeded (DevTools
    // stealing the debugger mid-start, or the target going away); its cleanup
    // nulled this.http, and address() on the closed server would be null.
    // Surface a typed error instead of a TypeError so callers can branch.
    if (this.http !== http) throw this.interruptedStartError();
    this.port = (http.address() as { port: number }).port;
    this.started = true;
    return { cdpEndpoint: this.endpointUrl() };
  }

  async stop(): Promise<void> {
    this.started = false;
    this.abortListen?.(this.interruptedStartError());
    // Fail every in-flight client command before closing, so a CDP client
    // (opencli has no remote-close handler) fails fast instead of hanging until
    // its own ~30s timeout.
    if (this.socket?.readyState === WebSocket.OPEN) {
      for (const [id, entry] of this.pending) {
        this.socket.send(
          JSON.stringify({
            id,
            error: { code: -32000, message: 'bridge closed' },
            ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
          }),
        );
      }
    }
    this.pending.clear();
    this.socket?.close();
    this.socket = null;
    this.wss?.close();
    this.wss = null;
    if (this.http) {
      const http = this.http;
      this.http = null;
      // socket.close() above flushed the error frames; this then drops the TCP
      // connection (possibly before the close handshake round-trips, so the
      // client may observe close code 1005 rather than 1000 — fine for a CDP
      // client) and frees anything half-open so close()'s callback always
      // fires (it does not, by itself, terminate the upgraded ws).
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
    if (!this.wc.isDestroyed()) {
      this.wc.off('destroyed', this.onDebuggerDetach);
      this.wc.debugger.off('message', this.onDebuggerMessage);
      this.wc.debugger.off('detach', this.onDebuggerDetach);
      if (this.wc.debugger.isAttached()) {
        try {
          this.wc.debugger.detach();
        } catch {
          /* already detached (e.g. DevTools took it) */
        }
      }
    }
  }

  private endpointUrl(): string {
    return `ws://127.0.0.1:${this.port}${this.path}`;
  }

  // Why a start was torn down from under its caller: the target is either
  // gone (window/view destroyed) or taken (DevTools owns the debugger now).
  private interruptedStartError(): CdpBridgeError {
    return this.wc.isDestroyed()
      ? new CdpBridgeError('target-destroyed', 'WebContents went away during start')
      : new CdpBridgeError('target-busy', 'bridge was stopped during start');
  }

  private listen(http: HttpServer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (complete: () => void) => {
        clearTimeout(timer);
        this.abortListen = null;
        complete();
      };
      const timer = setTimeout(
        () => settle(() => reject(new CdpBridgeError('bridge-start-timeout', 'ws bridge did not come up in time'))),
        BRIDGE_START_TIMEOUT_MS,
      );
      this.abortListen = (err) => settle(() => reject(err));
      http.once('error', (err) => settle(() => reject(err)));
      http.listen(0, '127.0.0.1', () => settle(resolve));
    });
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Rules 2/3: gate at the upgrade, BEFORE handing the socket to ws, so a
    // rejected attempt never occupies the single connection slot.
    if (!this.authorized(req)) {
      socket.destroy();
      return;
    }
    // Rule 4: one connection at a time.
    if (this.socket) {
      socket.destroy();
      return;
    }
    // stop() nulls wss while this 'upgrade' listener is still attached to the
    // http server; an upgrade arriving in that window must be dropped, not left
    // a silent no-op that abandons the socket neither adopted nor destroyed.
    const wss = this.wss;
    if (!wss) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.adopt(ws));
  };

  private authorized(req: IncomingMessage): boolean {
    // Rule 2: exact, constant-time secret match on the pathname (the path
    // carries the secret; a query string is allowed and ignored so a CDP
    // client appending parameters is not misrejected).
    const provided = Buffer.from(this.pathname(req));
    const expected = Buffer.from(this.path);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;
    // Rule 3: pin Host to the loopback authority; reject any browser Origin
    // (a real CDP client is not a browser and sends none).
    if (req.headers.host !== `127.0.0.1:${this.port}`) return false;
    if (req.headers.origin !== undefined) return false;
    return true;
  }

  private pathname(req: IncomingMessage): string {
    try {
      return new URL(req.url ?? '', 'ws://127.0.0.1').pathname;
    } catch {
      return '';
    }
  }

  private adopt(ws: WebSocket) {
    this.socket = ws;
    // A protocol error from the client (malformed frame, invalid UTF-8) emits
    // 'error' on the adopted socket; with no listener that is an uncaught
    // exception that kills the whole main process. Drop the connection instead.
    ws.on('error', () => ws.terminate());
    ws.on('message', (data) => void this.onClientMessage(ws, data));
    ws.on('close', () => {
      if (this.socket === ws) this.socket = null;
      // This connection's commands can no longer be answered; drop them so
      // their late completions are discarded instead of being delivered to a
      // future connection that happens to reuse the same ids.
      for (const [id, entry] of this.pending) if (entry.ws === ws) this.pending.delete(id);
    });
  }

  private async onClientMessage(ws: WebSocket, data: unknown) {
    let cmd: IncomingCommand;
    try {
      cmd = JSON.parse(String(data)) as IncomingCommand;
    } catch {
      return;
    }
    if (typeof cmd.id !== 'number' || typeof cmd.method !== 'string') return;
    const { id, sessionId } = cmd;
    this.pending.set(id, { ws, sessionId });
    try {
      const result = await this.wc.debugger.sendCommand(cmd.method, cmd.params ?? {}, sessionId);
      if (this.takePending(id, ws)) this.send({ id, result, ...(sessionId ? { sessionId } : {}) });
    } catch (err) {
      if (this.takePending(id, ws))
        this.send({
          id,
          error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          ...(sessionId ? { sessionId } : {}),
        });
    }
  }

  // True only while `id` is still pending AND still owned by `ws` — false after
  // teardown already failed it (don't double-send) or after the issuing
  // connection went away (don't leak a stale result to its successor).
  private takePending(id: number, ws: WebSocket): boolean {
    if (this.pending.get(id)?.ws !== ws) return false;
    this.pending.delete(id);
    return true;
  }

  // CDP events from the attached target are pushed straight to the client.
  private readonly onDebuggerMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
    this.send({ method, params, ...(sessionId ? { sessionId } : {}) });
  };

  // DevTools opening (or any external detach) forcibly detaches the debugger,
  // and a destroyed WebContents takes the target away entirely; either way,
  // tear the bridge down so the client sees a clean close instead of a hang.
  private readonly onDebuggerDetach = () => {
    void this.stop();
  };

  private send(payload: Record<string, unknown>) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }
}
