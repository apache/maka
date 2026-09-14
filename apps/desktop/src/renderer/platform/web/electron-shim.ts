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
 * Browser stand-in for Electron's `electron` module (`maka-web` full client).
 *
 * Loaded ONLY through the web boot chain (vite aliases `electron` here; the
 * Electron renderer never imports `electron`, so the alias never fires
 * there). It lets the browser execute the REAL preload bridge source
 * (`src/preload/preload.ts`) unmodified: `ipcRenderer` tunnels
 * invoke/on/off/send over same-origin `/bridge` (session cookie, no
 * query token), and `contextBridge` assigns the exposed bridge onto
 * `window`.
 *
 * Runtime shims included because the preload source assumes a Node-ish
 * preload context: minimal `Buffer.byteLength` (exact for utf8, the only
 * encoding the bridge uses) and an empty `process.env` (only read for the
 * E2E gate, which stays off in browsers). Both install lazily on first
 * import of this module — never in the Electron renderer.
 */

type IpcListener = (event: unknown, ...args: unknown[]) => void;

/** Must match `BYTES_TAG` in `src/main/web-bridge/protocol.ts`. */
const BYTES_TAG = '$makaBytes';

function reviveBridgeValue(value: unknown): unknown {
  if (value && typeof value === 'object' && typeof (value as { [BYTES_TAG]?: unknown })[BYTES_TAG] === 'string') {
    const encoded = (value as { [BYTES_TAG]: string })[BYTES_TAG];
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  if (Array.isArray(value)) return value.map(reviveBridgeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = reviveBridgeValue(entry);
    return out;
  }
  return value;
}

const INVOKE_TIMEOUT_MS = 120_000;

interface PendingInvoke {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

function installRuntimeShims(): void {
  const globals = globalThis as Record<string, unknown>;
  if (globals.Buffer === undefined) {
    globals.Buffer = {
      byteLength(input: unknown): number {
        const text = typeof input === 'string' ? input : String(input);
        return new TextEncoder().encode(text).length;
      },
    };
  }
  if (globals.process === undefined) {
    globals.process = { env: {} };
  }
}

installRuntimeShims();

class WebIpcRenderer {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingInvoke>();
  private readonly listeners = new Map<string, Set<IpcListener>>();
  private connectPromise: Promise<void> | undefined;

  connect(url: string): Promise<void> {
    if (this.socket) throw new Error('Web bridge is already connected.');
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Web bridge connection timed out. Is the GUI running?'));
      }, 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        this.socket = socket;
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Web bridge connection failed. Is the GUI running?'));
      }, { once: true });
      socket.addEventListener('message', (event) => {
        this.onMessage(event.data);
      });
      socket.addEventListener('close', () => {
        this.socket = undefined;
        const error = new Error('Web bridge connection closed.');
        for (const [id, invoke] of this.pending) {
          clearTimeout(invoke.timer);
          invoke.reject(error);
          this.pending.delete(id);
        }
      });
    });
    return this.connectPromise;
  }

  get connected(): boolean {
    return !!this.socket;
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    const message = frame as { t?: unknown; id?: unknown; channel?: unknown; args?: unknown; ok?: unknown; value?: unknown; error?: unknown };
    if (message.t === 'result' && typeof message.id === 'number') {
      const invoke = this.pending.get(message.id);
      if (!invoke) return;
      this.pending.delete(message.id);
      clearTimeout(invoke.timer);
      if (message.ok) invoke.resolve(reviveBridgeValue(message.value));
      else invoke.reject(new Error(typeof message.error === 'string' ? message.error : 'Web bridge call failed.'));
      return;
    }
    if (message.t === 'event' && typeof message.channel === 'string') {
      const channelListeners = this.listeners.get(message.channel);
      if (!channelListeners || channelListeners.size === 0) return;
      const args = Array.isArray(message.args) ? reviveBridgeValue(message.args) as unknown[] : [];
      for (const listener of [...channelListeners]) {
        try {
          listener({ senderId: 0 }, ...args);
        } catch {
          // One broken subscriber must never break bridge dispatch.
        }
      }
    }
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Web bridge is not connected.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Web bridge call timed out: ${channel}`));
      }, INVOKE_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ t: 'invoke', id, channel, args }));
    });
  }

  send(channel: string, ...args: unknown[]): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ t: 'notify', channel, args }));
    } catch {
      // Fire-and-forget stays fire-and-forget.
    }
  }

  on(channel: string, listener: IpcListener): void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
  }

  off(channel: string, listener: IpcListener): void {
    this.listeners.get(channel)?.delete(listener);
  }

  once(channel: string, listener: IpcListener): void {
    const wrapper: IpcListener = (event, ...args) => {
      this.off(channel, wrapper);
      listener(event, ...args);
    };
    this.on(channel, wrapper);
  }

  removeListener(channel: string, listener: IpcListener): void {
    this.off(channel, listener);
  }

  removeAllListeners(channel?: string): void {
    if (channel === undefined) this.listeners.clear();
    else this.listeners.delete(channel);
  }
}

export const ipcRenderer = new WebIpcRenderer();

export const contextBridge = {
  exposeInMainWorld(key: string, value: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = value;
  },
};
