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
 * Wire protocol for the `maka-web` bridge (Chrome/Brave full client).
 *
 * The browser cannot reach Electron's IPC, so the main process tunnels the
 * exact same channels over a loopback WebSocket: client `invoke` maps 1:1 to
 * `ipcMain.handle` listeners, and main→renderer `send` broadcasts map to
 * `event` frames the renderer's shim redispatches to `ipcRenderer.on`
 * subscribers. Method/channel names are NEVER translated — the browser runs
 * the real preload bridge source, so both ends must agree byte-for-byte.
 *
 * Frames are JSON text. Payloads must be JSON-safe; `encodeFrame` wraps
 * Uint8Array/Buffer as an explicit envelope so transcript fragments
 * survive the tunnel instead of hanging the browser invoke.
 */

export type BridgeRequest =
  | { t: 'invoke'; id: number; channel: string; args: unknown[] }
  | { t: 'notify'; channel: string; args: unknown[] };

export type BridgeResponse =
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }
  | { t: 'event'; channel: string; args: unknown[] };

const BYTES_TAG = '$makaBytes';

interface BytesEnvelope {
  [BYTES_TAG]: string;
}

function isBytesEnvelope(value: unknown): value is BytesEnvelope {
  return !!value && typeof value === 'object' && typeof (value as BytesEnvelope)[BYTES_TAG] === 'string';
}

/**
 * Throws on values JSON.stringify would silently drop or mis-shape
 * (functions, symbols, bigint, true circular refs). `undefined` is
 * allowed (JSON omits object keys / nulls array holes). Typed arrays
 * are leaves here; `encodeFrame` wraps them. Shared aliases
 * (`latestEntry === entries[0]`) are not cycles.
 */
export function assertJsonSafe(value: unknown, what: string): void {
  // Stack (not a global seen-set): shared aliases like `latestEntry ===
  // entries[0]` are JSON-safe; only a true cycle is not.
  const stack = new Set<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === undefined) return;
    if (typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') {
      throw new Error(`${what} is not JSON-safe (${path} is ${typeof node})`);
    }
    if (!node || typeof node !== 'object') return;
    if (stack.has(node)) throw new Error(`${what} is not JSON-safe (${path} is circular)`);
    if (ArrayBuffer.isView(node)) return;
    stack.add(node);
    try {
      if (Array.isArray(node)) {
        node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
        return;
      }
      for (const [key, entry] of Object.entries(node)) visit(entry, `${path}.${key}`);
    } finally {
      stack.delete(node);
    }
  };
  visit(value, '$');
}

export function wrapBytes(data: Uint8Array): BytesEnvelope {
  return { [BYTES_TAG]: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') };
}

export function unwrapBytes(value: unknown): Uint8Array | undefined {
  if (!isBytesEnvelope(value)) return undefined;
  return new Uint8Array(Buffer.from(value[BYTES_TAG], 'base64'));
}

/** Revive bytes envelopes anywhere in a decoded frame (returns a copy). */
export function reviveFrame<T>(value: T): T {
  if (isBytesEnvelope(value)) return unwrapBytes(value) as T;
  if (Array.isArray(value)) return value.map((entry) => reviveFrame(entry)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = reviveFrame(entry);
    return out as T;
  }
  return value;
}

export function encodeFrame(frame: BridgeRequest | BridgeResponse): string {
  assertJsonSafe(frame, 'bridge frame');
  return JSON.stringify(frame, (_key, value) => {
    if (!ArrayBuffer.isView(value)) return value;
    const bytes = value instanceof Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return wrapBytes(bytes);
  });
}

/**
 * Encode a server→browser frame. Result frames that still fail (true
 * circular refs, functions) become an error result so the renderer
 * invoke rejects instead of hanging until the 120s timeout.
 */
export function encodeOutboundFrame(frame: BridgeResponse): string {
  try {
    return encodeFrame(frame);
  } catch (error) {
    if (frame.t !== 'result') throw error;
    return encodeFrame({
      t: 'result',
      id: frame.id,
      ok: false,
      error: `Web bridge could not encode result: ${errorMessage(error)}`,
    });
  }
}

export function decodeFrame(raw: string): BridgeRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('bridge frame is not JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('bridge frame is not an object');
  const frame = parsed as { t?: unknown; channel?: unknown; args?: unknown; id?: unknown };
  if (frame.t !== 'invoke' && frame.t !== 'notify') throw new Error('bridge frame has unknown type');
  if (typeof frame.channel !== 'string' || !frame.channel) throw new Error('bridge frame is missing channel');
  if (!Array.isArray(frame.args)) throw new Error('bridge frame args must be an array');
  if (frame.t === 'invoke' && (typeof frame.id !== 'number' || !Number.isInteger(frame.id))) {
    throw new Error('bridge invoke frame is missing id');
  }
  return reviveFrame(frame as BridgeRequest);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string' && error) return error;
  try {
    return `bridge error: ${JSON.stringify(error)}`;
  } catch {
    return 'bridge error: <unserializable>';
  }
}
