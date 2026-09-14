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

import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { addWebBroadcastListener } from './bus.js';
import { WEB_BRIDGE_HOST, WEB_BRIDGE_PORT } from './port.js';
import { decodeFrame, encodeFrame, encodeOutboundFrame, errorMessage, type BridgeResponse } from './protocol.js';
import { WebBridgeRegistry, setWebBridgeMirror, webBridgeMirror } from './registry.js';
import { VirtualWebSender, virtualInvokeEvent } from './virtual-sender.js';

/**
 * Loopback WebSocket server that tunnels Electron IPC to `maka-web`
 * browsers. Security posture mirrors the CDP bridge precedent:
 * 127.0.0.1-only, per-launch high-entropy token, strict Origin allowlist.
 * The browser never sees the token: the web gateway attaches it only on
 * this loopback hop. Node clients from loopback may omit Origin.
 */

export const WEB_BRIDGE_TOKEN_BYTES = 32;
const HEARTBEAT_MS = 30_000;

export interface WebBridgeInfo {
  /** `ws://127.0.0.1:<port>` (no token — the gateway appends it on the loopback hop). */
  wsUrl: string;
  token: string;
  tokenFile: string;
}

export interface StartedWebBridge extends WebBridgeInfo {
  registry: WebBridgeRegistry;
  clients: () => number;
  stop(): Promise<void>;
}

function tokenFilePath(): string {
  const override = process.env.MAKA_WEB_BRIDGE_FILE?.trim();
  if (override) return override;
  return join(tmpdir(), 'maka-web-bridge.json');
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

/**
 * Pure per-connection router (no sockets): invoke → registry dispatch with a
 * virtual sender, notify → dropped, garbage → dropped. Extracted so the
 * protocol logic is unit-testable without binding a port.
 */
export interface BridgeConnection {
  sender: VirtualWebSender;
  /** Route one inbound text frame; never throws (drops garbage loudly). */
  handleMessage(text: string): void;
  destroy(): void;
}

export function createBridgeConnection(
  registry: WebBridgeRegistry,
  deliver: (frame: BridgeResponse) => void,
): BridgeConnection {
  const sender = new VirtualWebSender((channel, args) => {
    deliver({ t: 'event', channel, args });
  });
  return {
    sender,
    handleMessage(text: string): void {
      let request;
      try {
        request = decodeFrame(text);
      } catch (error) {
        // Malformed frames get no correlation id to answer on; drop loudly.
        console.warn(`[web-bridge] dropping malformed frame: ${errorMessage(error)}`);
        return;
      }
      if (request.t === 'notify') {
        // Fire-and-forget renderer signals (today: embedded-browser only).
        // No web-side `on` registry exists yet; unknown notifies are dropped
        // so a chatty tab can never wedge the main process.
        return;
      }
      const listener = registry.get(request.channel);
      if (!listener) {
        deliver({
          t: 'result',
          id: request.id,
          ok: false,
          error: `Web bridge has no channel: ${request.channel}`,
        });
        return;
      }
      void Promise.resolve()
        .then(() => listener(virtualInvokeEvent(sender) as never, ...request.args))
        .then(
          (value) => deliver({ t: 'result', id: request.id, ok: true, value }),
          (error) => deliver({ t: 'result', id: request.id, ok: false, error: errorMessage(error) }),
        );
    },
    destroy(): void {
      sender.destroy();
    },
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Pure upgrade gate (no sockets): unit-testable without binding a port. */
export function authorizeUpgrade(
  requestUrl: string,
  origin: string | undefined,
  token: string,
  remoteAddress?: string,
): { ok: true } | { ok: false; code: number; message: string } {
  let presented: string | null;
  try {
    presented = new URL(requestUrl, 'ws://127.0.0.1').searchParams.get('token');
  } catch {
    return { ok: false, code: 400, message: 'Bad Request' };
  }
  if (presented !== token) return { ok: false, code: 401, message: 'Unauthorized' };
  if (!origin) {
    if (isLoopbackAddress(remoteAddress)) return { ok: true };
    return { ok: false, code: 403, message: 'Forbidden' };
  }
  if (!isAllowedOrigin(origin)) return { ok: false, code: 403, message: 'Forbidden' };
  return { ok: true };
}

export async function startWebBridgeServer(options?: { webAccessPath: string }): Promise<StartedWebBridge> {
  const registry = new WebBridgeRegistry();
  const token = randomBytes(WEB_BRIDGE_TOKEN_BYTES).toString('hex');
  const wss = new WebSocketServer({
    host: WEB_BRIDGE_HOST,
    port: WEB_BRIDGE_PORT,
    // Gate upgrades BEFORE the handshake: wrong token or foreign origin never
    // completes, so no application bytes are exchanged with strangers.
    verifyClient: (info, done) => {
      const verdict = authorizeUpgrade(
        info.req.url ?? '/',
        info.origin,
        token,
        info.req.socket.remoteAddress,
      );
      if (verdict.ok) done(true);
      else done(false, verdict.code, verdict.message);
    },
  });
  const sockets = new Set<WebSocket>();
  const heartbeats = new Set<NodeJS.Timeout>();

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException)?.code;
      reject(
        code === 'EADDRINUSE'
          ? new Error(
              `Web bridge port ${WEB_BRIDGE_PORT} is busy (another Maka profile owns it); bridge disabled.`,
            )
          : error,
      );
    });
  });
  const wsUrl = `ws://${WEB_BRIDGE_HOST}:${WEB_BRIDGE_PORT}`;

  const sendFrame = (socket: WebSocket, frame: BridgeResponse): void => {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(encodeOutboundFrame(frame));
    } catch (error) {
      console.warn(`[web-bridge] dropping unencodable ${frame.t} frame: ${errorMessage(error)}`);
    }
  };

  const removeBroadcast = addWebBroadcastListener((channel, args) => {
    const frame: BridgeResponse = { t: 'event', channel, args };
    let payload: string;
    try {
      payload = encodeFrame(frame);
    } catch (error) {
      console.warn(`[web-bridge] dropping unencodable event ${channel}: ${errorMessage(error)}`);
      return;
    }
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        try {
          socket.send(payload);
        } catch {
          // Per-client best effort; dead sockets are reaped by close/pong.
        }
      }
    }
  });


  // Thin socket adapter over the pure connection router above.
  wss.on('connection', (socket: WebSocket) => {
    sockets.add(socket);
    const connection = createBridgeConnection(registry, (frame) => sendFrame(socket, frame));
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    heartbeats.add(heartbeat);
    socket.on('pong', () => {
      alive = true;
    });
    socket.on('message', (data) => {
      connection.handleMessage(
        typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8'),
      );
    });
    const teardown = (): void => {
      clearInterval(heartbeat);
      heartbeats.delete(heartbeat);
      sockets.delete(socket);
      connection.destroy();
    };
    socket.on('close', teardown);
    socket.on('error', teardown);
  });

  setWebBridgeMirror(registry);
  const tokenFile = tokenFilePath();
  const info: WebBridgeInfo = { wsUrl, token, tokenFile };
  try {
    await mkdir(dirname(tokenFile), { recursive: true });
    await writeFile(
      tokenFile,
      JSON.stringify({
        ...info,
        pid: process.pid,
        startedAt: Date.now(),
        webAccessPath: options?.webAccessPath,
      }),
      {
        encoding: 'utf8',
        mode: 0o600,
      },
    );
    await chmod(tokenFile, 0o600).catch(() => undefined);
  } catch (error) {
    console.warn(`[web-bridge] could not write token file ${tokenFile}: ${errorMessage(error)}`);
  }
  console.log(`[web-bridge] listening on ${wsUrl} (token in ${tokenFile})`);

  let stopped = false;
  return {
    ...info,
    registry,
    clients: () => sockets.size,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const heartbeat of heartbeats) clearInterval(heartbeat);
      heartbeats.clear();
      removeBroadcast();
      if (webBridgeMirror() === registry) setWebBridgeMirror(undefined);
      for (const socket of [...sockets]) {
        try {
          socket.close(1001, 'bridge stopping');
        } catch {
          // Ignored: sockets are reaped by their own teardown.
        }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
