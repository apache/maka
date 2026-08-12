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
  handler?: BoundHandler;
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
  #activeEpoch: string | undefined;
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
      isActive: () => this.#activeEpoch === epoch,
      handle: (channel, listener) =>
        this.#handle(epoch, owner, channel, listener, false),
      handleReconnectableRead: (channel, listener) =>
        this.#handle(epoch, owner, channel, listener, true),
      removeHandler: (channel) => this.#removeHandler(owner, channel),
    };
  }

  activate(epoch: string): void {
    if (this.#closed) throw new Error("Desktop Runtime Host IPC router is closed");
    if (this.#activeEpoch === epoch) return;
    const previous = this.#activeEpoch;
    this.#activeEpoch = epoch;
    if (previous !== undefined) this.#rejectEpoch(previous);
  }

  isActive(epoch: string): boolean {
    return this.#activeEpoch === epoch;
  }

  deactivate(epoch: string): void {
    if (this.#activeEpoch !== epoch) return;
    this.#activeEpoch = undefined;
    this.#rejectEpoch(epoch);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#activeEpoch = undefined;
    const error = new Error("Desktop Runtime Host IPC router is closed");
    for (const [channel, slot] of this.#slots) {
      for (const waiter of slot.waiters) waiter.reject(error);
      slot.waiters.clear();
      slot.handler = undefined;
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
      const created: HandlerSlot = { waiters: new Set(), reconnectableRead };
      this.#ipcMain.handle(channel, (event, ...args) =>
        this.#dispatch(created, event, args),
      );
      this.#slots.set(channel, created);
      slot = created;
    }
    if (slot.reconnectableRead !== reconnectableRead) {
      throw new Error(`Desktop Runtime Host IPC policy changed: ${channel}`);
    }
    if (slot.handler) {
      throw new Error(`Desktop Runtime Host IPC handler already exists: ${channel}`);
    }
    const handler = { epoch, owner, listener };
    slot.handler = handler;
    for (const waiter of [...slot.waiters]) {
      if (waiter.epoch !== epoch) continue;
      slot.waiters.delete(waiter);
      waiter.resolve(handler);
    }
  }

  #removeHandler(owner: symbol, channel: string): void {
    const slot = this.#slots.get(channel);
    if (slot?.handler?.owner === owner) slot.handler = undefined;
  }

  async #dispatch(
    slot: HandlerSlot,
    event: Parameters<IpcHandler>[0],
    args: readonly unknown[],
  ): Promise<unknown> {
    const epoch = this.#requireActiveEpoch();
    let handler = slot.handler?.epoch === epoch ? slot.handler : undefined;
    if (!handler) handler = await this.#waitForHandler(slot, epoch);
    while (true) {
      try {
        const result = await handler.listener(event, ...args);
        this.#assertActive(epoch);
        if (slot.reconnectableRead && slot.handler !== handler) {
          handler = await this.#waitForHandler(slot, epoch, handler);
          continue;
        }
        return result;
      } catch (error) {
        this.#assertActive(epoch);
        if (slot.reconnectableRead && slot.handler !== handler) {
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
    if (
      slot.handler?.epoch === epoch &&
      slot.handler !== previous
    ) {
      return Promise.resolve(slot.handler);
    }
    return new Promise((resolve, reject) => {
      slot.waiters.add({ epoch, resolve, reject });
    });
  }

  #requireActiveEpoch(): string {
    if (this.#closed) throw new Error("Desktop Runtime Host IPC router is closed");
    if (this.#activeEpoch === undefined) throw new RuntimeHostTargetChangedError();
    return this.#activeEpoch;
  }

  #assertActive(epoch: string): void {
    if (this.#activeEpoch !== epoch) throw new RuntimeHostTargetChangedError();
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
