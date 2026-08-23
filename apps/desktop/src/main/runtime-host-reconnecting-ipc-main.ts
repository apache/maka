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

import type { IpcMain } from "electron";
import {
  isReconnectableReadFailure,
  type IpcHandler,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";

interface HandlerWaiter {
  readonly epoch: string;
  readonly resolve: (handler: BoundHandler) => void;
  readonly reject: (error: Error) => void;
}

interface BoundHandler {
  readonly epoch: string;
  readonly owner: symbol;
  readonly listener: IpcHandler;
}

interface HandlerSlot {
  readonly waiters: Set<HandlerWaiter>;
  readonly reconnectableRead: boolean;
  readonly handlers: Map<string, BoundHandler>;
}

export interface RuntimeHostTargetIpcMain
  extends ReconnectableReadIpcMain,
    Pick<IpcMain, "removeHandler"> {
  readonly epoch: string;
  isActive(): boolean;
}

export class RuntimeHostTargetChangedError extends Error {
  constructor() {
    super("Runtime Host target changed while the request was in progress");
    this.name = "RuntimeHostTargetChangedError";
  }
}

/**
 * Keeps Electron IPC registration stable across reconnects while fencing each
 * target generation. Reconnectable reads may move to a replacement candidate,
 * but a late result from the replaced candidate is never returned.
 */
export class RuntimeHostReconnectingIpcMain {
  readonly #ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly #slots = new Map<string, HandlerSlot>();
  readonly #activeEpochs = new Set<string>();
  #closed = false;

  constructor(ipcMain: Pick<IpcMain, "handle" | "removeHandler">) {
    this.#ipcMain = ipcMain;
  }

  createTarget(epoch: string): RuntimeHostTargetIpcMain {
    if (this.#closed) throw new Error("Desktop Runtime Host IPC router is closed");
    if (!epoch) throw new Error("Desktop Runtime Host target epoch is required");
    const owner = Symbol(epoch);
    return {
      epoch,
      isActive: () => this.#activeEpochs.has(epoch),
      handle: (channel, listener) =>
        this.#handle(epoch, owner, channel, listener, false),
      handleReconnectableRead: (channel, listener) =>
        this.#handle(epoch, owner, channel, listener, true),
      removeHandler: (channel) => this.#removeHandler(owner, channel),
    };
  }

  activate(epoch: string): void {
    if (this.#closed) throw new Error("Desktop Runtime Host IPC router is closed");
    this.#activeEpochs.add(epoch);
  }

  isActive(epoch: string): boolean {
    return this.#activeEpochs.has(epoch);
  }

  deactivate(epoch: string): void {
    if (!this.#activeEpochs.delete(epoch)) return;
    this.#rejectEpoch(epoch);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#activeEpochs.clear();
    const error = new Error("Desktop Runtime Host IPC router is closed");
    for (const [channel, slot] of this.#slots) {
      for (const waiter of slot.waiters) waiter.reject(error);
      slot.waiters.clear();
      slot.handlers.clear();
      this.#ipcMain.removeHandler(channel);
    }
    this.#slots.clear();
  }

  #handle(
    epoch: string,
    owner: symbol,
    channel: string,
    listener: IpcHandler,
    reconnectableRead: boolean,
  ): void {
    if (this.#closed) throw new Error("Desktop Runtime Host IPC router is closed");
    let slot = this.#slots.get(channel);
    if (!slot) {
      const created: HandlerSlot = {
        handlers: new Map(),
        waiters: new Set(),
        reconnectableRead,
      };
      this.#ipcMain.handle(channel, (event, ...args) =>
        this.#dispatch(created, event, args),
      );
      this.#slots.set(channel, created);
      slot = created;
    }
    if (slot.reconnectableRead !== reconnectableRead) {
      throw new Error(`Desktop Runtime Host IPC policy changed: ${channel}`);
    }
    if (slot.handlers.has(epoch)) {
      throw new Error(`Desktop Runtime Host IPC handler already exists: ${channel}`);
    }
    const handler = { epoch, owner, listener };
    slot.handlers.set(epoch, handler);
    for (const waiter of [...slot.waiters]) {
      if (waiter.epoch !== epoch) continue;
      slot.waiters.delete(waiter);
      waiter.resolve(handler);
    }
  }

  #removeHandler(owner: symbol, channel: string): void {
    const slot = this.#slots.get(channel);
    if (!slot) return;
    for (const [epoch, handler] of slot.handlers) {
      if (handler.owner === owner) slot.handlers.delete(epoch);
    }
  }

  async #dispatch(
    slot: HandlerSlot,
    event: Parameters<IpcHandler>[0],
    args: readonly unknown[],
  ): Promise<unknown> {
    const epoch = this.#requireTargetEpoch(args[0]);
    let handler = slot.handlers.get(epoch);
    if (!handler) handler = await this.#waitForHandler(slot, epoch);
    while (true) {
      try {
        const result = await handler.listener(event, ...args);
        this.#assertActive(epoch);
        if (slot.reconnectableRead && slot.handlers.get(epoch) !== handler) {
          handler = await this.#waitForHandler(slot, epoch, handler);
          continue;
        }
        return result;
      } catch (error) {
        this.#assertActive(epoch);
        if (slot.reconnectableRead && slot.handlers.get(epoch) !== handler) {
          handler = await this.#waitForHandler(slot, epoch, handler);
          continue;
        }
        if (!slot.reconnectableRead || !isReconnectableReadFailure(error)) {
          throw error;
        }
        handler = await this.#waitForHandler(slot, epoch, handler);
      }
    }
  }

  #waitForHandler(
    slot: HandlerSlot,
    epoch: string,
    previous?: BoundHandler,
  ): Promise<BoundHandler> {
    try {
      this.#assertActive(epoch);
    } catch (error) {
      return Promise.reject(error);
    }
    const current = slot.handlers.get(epoch);
    if (current !== undefined && current !== previous) {
      return Promise.resolve(current);
    }
    return new Promise((resolve, reject) => {
      slot.waiters.add({ epoch, resolve, reject });
    });
  }

  #requireTargetEpoch(value: unknown): string {
    if (this.#closed) throw new Error("Desktop Runtime Host IPC router is closed");
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { targetEpoch?: unknown }).targetEpoch !== "string" ||
      !(value as { targetEpoch: string }).targetEpoch
    ) {
      throw new RuntimeHostTargetChangedError();
    }
    const epoch = (value as { targetEpoch: string }).targetEpoch;
    this.#assertActive(epoch);
    return epoch;
  }

  #assertActive(epoch: string): void {
    if (!this.#activeEpochs.has(epoch)) throw new RuntimeHostTargetChangedError();
  }

  #rejectEpoch(epoch: string): void {
    const error = new RuntimeHostTargetChangedError();
    for (const slot of this.#slots.values()) {
      for (const waiter of [...slot.waiters]) {
        if (waiter.epoch !== epoch) continue;
        slot.waiters.delete(waiter);
        waiter.reject(error);
      }
    }
  }
}
