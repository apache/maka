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

import type { IpcHandler } from '../ipc-reconnect-policy.js';

/**
 * Channel registry for the `maka-web` bridge: the WebSocket side of the
 * `ReconnectableReadIpcMain` contract (`handle` + `removeHandler`).
 *
 * `ScopedIpcMain` mirrors every per-target registration here, so the browser
 * speaks the identical channel set with identical scope validation — the
 * wrapped listeners (including `requireDesktopTargetScope`) are shared, not
 * reimplemented. Overlay semantics are last-active-wins: targets already
 * serialize activation through `close()` (which mirrors `removeHandler`),
 * and the browser always addresses the active target via its scope objects.
 *
 * The one deliberate difference from Electron's `ipcMain.handle`: duplicates
 * overwrite instead of throwing, so a stale close that never ran cannot wedge
 * the bridge. Teardown still removes promptly via the mirrored `close()`.
 */

export interface WebBridgeMirror {
  handle(channel: string, listener: IpcHandler): void;
  removeHandler(channel: string): void;
}

let mirror: WebBridgeMirror | undefined;

/**
 * Registrations that arrive before `startWebBridgeServer` (channel setup runs
 * during boot, the server starts in `wireLifecycle`). Queued and replayed in
 * order on start; removals cancel matching queued registrations. This keeps
 * every call site order-agnostic: nobody has to reason about boot sequencing.
 */
const pending: Array<{ channel: string; listener: IpcHandler } | { remove: string }> = [];

export function setWebBridgeMirror(next: WebBridgeMirror | undefined): void {
  mirror = next;
  if (!next) return;
  const replay = pending.splice(0, pending.length);
  for (const entry of replay) {
    if ('remove' in entry) next.removeHandler(entry.remove);
    else next.handle(entry.channel, entry.listener);
  }
}

export function mirrorHandle(channel: string, listener: IpcHandler): void {
  if (mirror) {
    mirror.handle(channel, listener);
    return;
  }
  const queued = pending.findIndex((entry) => !('remove' in entry) && entry.channel === channel);
  const record = { channel, listener };
  if (queued === -1) pending.push(record);
  else pending[queued] = record;
}

export function mirrorRemove(channel: string): void {
  if (mirror) {
    mirror.removeHandler(channel);
    return;
  }
  for (let index = pending.length - 1; index >= 0; index--) {
    const entry = pending[index];
    if (!('remove' in entry) && entry.channel === channel) pending.splice(index, 1);
  }
}

export function webBridgeMirror(): WebBridgeMirror | undefined {
  return mirror;
}

export class WebBridgeRegistry implements WebBridgeMirror {
  private readonly listeners = new Map<string, IpcHandler>();

  handle(channel: string, listener: IpcHandler): void {
    if (!channel) throw new TypeError('Web bridge channel must be a non-empty string.');
    if (typeof listener !== 'function') throw new TypeError('Web bridge listener must be a function.');
    this.listeners.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.listeners.delete(channel);
  }

  has(channel: string): boolean {
    return this.listeners.has(channel);
  }

  get(channel: string): IpcHandler | undefined {
    return this.listeners.get(channel);
  }

  channels(): string[] {
    return [...this.listeners.keys()];
  }
}
