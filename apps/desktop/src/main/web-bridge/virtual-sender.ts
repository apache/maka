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
 * Per-connection virtual sender for the `maka-web` bridge.
 *
 * Main-process IPC handlers receive `(event, ...args)` and use
 * `event.sender` for per-renderer state: transcript/session observation
 * targets (`send` + `once/off('destroyed')` + `id`), attachment approval
 * scopes (`id`), progress callbacks (`isDestroyed` + `send`). The virtual
 * sender implements exactly that surface over one WebSocket, so tunneled
 * invokes behave like first-class renderers: observation streams, approval
 * dialogs-worth-of-state, and transcript consumers are all keyed per browser
 * tab, the way Electron keys them per WebContents.
 *
 * IDs are negative and process-unique so they can never collide with a real
 * WebContents id (>= 1).
 */

export interface VirtualSenderEvents {
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
}

let nextVirtualSenderId = -1;

export class VirtualWebSender {
  readonly id: number;
  private destroyed = false;
  private readonly destroyedListeners = new Set<() => void>();
  private readonly deliver: (channel: string, args: unknown[]) => void;

  constructor(deliver: (channel: string, args: unknown[]) => void) {
    this.id = nextVirtualSenderId;
    nextVirtualSenderId -= 1;
    this.deliver = deliver;
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) return;
    this.deliver(channel, args);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: 'destroyed', listener: () => void): void {
    if (event !== 'destroyed') return;
    if (this.destroyed) {
      listener();
      return;
    }
    this.destroyedListeners.add(listener);
  }

  off(event: 'destroyed', listener: () => void): void {
    if (event !== 'destroyed') return;
    this.destroyedListeners.delete(listener);
  }

  /** Called when the underlying socket closes: releases observations. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const listeners = [...this.destroyedListeners];
    this.destroyedListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Listener cleanup must never break connection teardown.
      }
    }
  }
}

/** The `event` object handed to tunneled `handle` listeners. */
export function virtualInvokeEvent(sender: VirtualWebSender): {
  sender: VirtualWebSender;
  senderFrame: null;
  frameId: number;
  processId: number;
} {
  return { sender, senderFrame: null, frameId: 0, processId: 0 };
}
