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
  type ReconciledControlHandlers,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";

type ReconcileIpcHandler = (
  context: unknown,
  event: Parameters<IpcHandler>[0],
  ...args: unknown[]
) => Promise<unknown>;

type ReconciliationUnavailableIpcHandler = ReconcileIpcHandler;

const DEFAULT_REPLACEMENT_WAIT_TIMEOUT_MS = 15_000;

export interface RuntimeHostReconnectingIpcMainOptions {
  readonly replacementWaitTimeoutMs?: number;
}

class HandlerWaitExpiredError extends Error {
  constructor() {
    super("Runtime Host replacement wait expired");
    this.name = "HandlerWaitExpiredError";
  }
}

interface HandlerWaiter {
  readonly epoch: string;
  readonly resolve: (handler: BoundHandler) => void;
  readonly reject: (error: Error) => void;
}

interface BoundHandler {
  readonly epoch: string;
  readonly owner: symbol;
  readonly listener: IpcHandler;
  readonly reconcile?: ReconcileIpcHandler;
  readonly reconciliationUnavailable?: ReconciliationUnavailableIpcHandler;
}

interface HandlerSlot {
  readonly waiters: Set<HandlerWaiter>;
  readonly reconnectableRead: boolean;
  readonly reconciledControl: boolean;
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

export class RuntimeHostHandlerUnavailableError extends Error {
  constructor() {
    super("Runtime Host handler remained unavailable after the reconnection window");
    this.name = "RuntimeHostHandlerUnavailableError";
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
  readonly #replacementWaitTimeoutMs: number;
  #closed = false;

  constructor(
    ipcMain: Pick<IpcMain, "handle" | "removeHandler">,
    options: RuntimeHostReconnectingIpcMainOptions = {},
  ) {
    this.#ipcMain = ipcMain;
    const replacementWaitTimeoutMs =
      options.replacementWaitTimeoutMs ?? DEFAULT_REPLACEMENT_WAIT_TIMEOUT_MS;
    if (!Number.isSafeInteger(replacementWaitTimeoutMs) || replacementWaitTimeoutMs <= 0) {
      throw new TypeError("Runtime Host replacement wait timeout must be positive");
    }
    this.#replacementWaitTimeoutMs = replacementWaitTimeoutMs;
  }

  createTarget(epoch: string): RuntimeHostTargetIpcMain {
    if (this.#closed) throw new Error("Desktop Runtime Host IPC router is closed");
    if (!epoch) throw new Error("Desktop Runtime Host target epoch is required");
    const owner = Symbol(epoch);
    return {
      epoch,
      isActive: () => this.#activeEpochs.has(epoch),
      handle: (channel, listener) =>
        this.#handle(epoch, owner, channel, listener, false, false),
      handleReconnectableRead: (channel, listener) =>
        this.#handle(epoch, owner, channel, listener, true, false),
      handleReconciledControl: (channel, handlers) =>
        this.#handleReconciledControl(epoch, owner, channel, handlers),
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
    reconciledControl: boolean,
    reconcile?: ReconcileIpcHandler,
    reconciliationUnavailable?: ReconciliationUnavailableIpcHandler,
  ): void {
    if (this.#closed) throw new Error("Desktop Runtime Host IPC router is closed");
    let slot = this.#slots.get(channel);
    if (!slot) {
      const created: HandlerSlot = {
        handlers: new Map(),
        waiters: new Set(),
        reconnectableRead,
        reconciledControl,
      };
      this.#ipcMain.handle(channel, (event, ...args) =>
        this.#dispatch(created, event, args),
      );
      this.#slots.set(channel, created);
      slot = created;
    }
    if (
      slot.reconnectableRead !== reconnectableRead ||
      slot.reconciledControl !== reconciledControl
    ) {
      throw new Error(`Desktop Runtime Host IPC policy changed: ${channel}`);
    }
    if (slot.handlers.has(epoch)) {
      throw new Error(`Desktop Runtime Host IPC handler already exists: ${channel}`);
    }
    const handler = {
      epoch,
      owner,
      listener,
      ...(reconcile ? { reconcile } : {}),
      ...(reconciliationUnavailable ? { reconciliationUnavailable } : {}),
    };
    slot.handlers.set(epoch, handler);
    for (const waiter of [...slot.waiters]) {
      if (waiter.epoch !== epoch) continue;
      slot.waiters.delete(waiter);
      waiter.resolve(handler);
    }
  }

  #handleReconciledControl<Context, Result>(
    epoch: string,
    owner: symbol,
    channel: string,
    handlers: ReconciledControlHandlers<Context, Result>,
  ): void {
    this.#handle(
      epoch,
      owner,
      channel,
      handlers.dispatch as IpcHandler,
      false,
      true,
      handlers.reconcile as unknown as ReconcileIpcHandler,
      handlers.reconciliationUnavailable as unknown as ReconciliationUnavailableIpcHandler,
    );
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
    let reconciling = false;
    let replacementDeadline: number | undefined;
    const waitForReplacement = async (
      previous?: BoundHandler,
    ): Promise<BoundHandler | undefined> => {
      // One invocation gets one monotonic replacement window across every
      // candidate it visits; flapping must not restart its lifetime.
      replacementDeadline ??= performance.now() + this.#replacementWaitTimeoutMs;
      const remainingMs = Math.max(0, replacementDeadline - performance.now());
      try {
        if (remainingMs <= 0) throw new HandlerWaitExpiredError();
        return await this.#waitForHandler(slot, epoch, previous, remainingMs);
      } catch (error) {
        if (!(error instanceof HandlerWaitExpiredError)) throw error;
        if (reconciling) return undefined;
        throw new RuntimeHostHandlerUnavailableError();
      }
    };
    const initialHandler = slot.handlers.get(epoch) ?? await waitForReplacement();
    if (!initialHandler) throw new RuntimeHostHandlerUnavailableError();
    let handler: BoundHandler = initialHandler;
    let reconciliationContext: unknown;
    const unavailable = (): Promise<unknown> =>
      requireReconciliationUnavailableHandler(handler)(
        reconciliationContext,
        event,
        ...args,
      );
    while (true) {
      try {
        const result = reconciling
          ? await requireReconcileHandler(handler)(reconciliationContext, event, ...args)
          : await handler.listener(event, ...args);
        this.#assertActive(epoch);
        if (
          (slot.reconnectableRead || reconciling) &&
          slot.handlers.get(epoch) !== handler
        ) {
          const replacement = await waitForReplacement(handler);
          if (!replacement) return unavailable();
          handler = replacement;
          continue;
        }
        if (slot.reconciledControl && !reconciling) {
          const step = requireReconciledControlStep(result);
          if (step.kind === "completed") return step.value;
          reconciliationContext = step.context;
          reconciling = true;
          const replacement = await waitForReplacement(handler);
          if (!replacement) return unavailable();
          handler = replacement;
          continue;
        }
        return result;
      } catch (error) {
        this.#assertActive(epoch);
        if (
          (slot.reconnectableRead || reconciling) &&
          slot.handlers.get(epoch) !== handler
        ) {
          const replacement = await waitForReplacement(handler);
          if (!replacement) return unavailable();
          handler = replacement;
          continue;
        }
        if (
          (!slot.reconnectableRead && !reconciling) ||
          !isReconnectableReadFailure(error)
        ) {
          throw error;
        }
        const replacement = await waitForReplacement(handler);
        if (!replacement) return unavailable();
        handler = replacement;
      }
    }
  }

  #waitForHandler(
    slot: HandlerSlot,
    epoch: string,
    previous?: BoundHandler,
    timeoutMs?: number,
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
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      return Promise.reject(new HandlerWaitExpiredError());
    }
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const waiter: HandlerWaiter = {
        epoch,
        resolve: (handler) => {
          if (timeout !== undefined) clearTimeout(timeout);
          resolve(handler);
        },
        reject: (error) => {
          if (timeout !== undefined) clearTimeout(timeout);
          reject(error);
        },
      };
      slot.waiters.add(waiter);
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (!slot.waiters.delete(waiter)) return;
          waiter.reject(new HandlerWaitExpiredError());
        }, timeoutMs);
      }
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

function requireReconcileHandler(handler: BoundHandler): ReconcileIpcHandler {
  if (!handler.reconcile) {
    throw new Error("Desktop Runtime Host reconciled control handler is unavailable");
  }
  return handler.reconcile;
}

function requireReconciliationUnavailableHandler(
  handler: BoundHandler,
): ReconciliationUnavailableIpcHandler {
  if (!handler.reconciliationUnavailable) {
    throw new Error("Desktop Runtime Host reconciliation fallback is unavailable");
  }
  return handler.reconciliationUnavailable;
}

function requireReconciledControlStep(
  value: unknown,
): { readonly kind: "completed"; readonly value: unknown } | {
  readonly kind: "reconcile";
  readonly context: unknown;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Desktop Runtime Host reconciled control returned an invalid step");
  }
  const step = value as { kind?: unknown; value?: unknown; context?: unknown };
  if (step.kind === "completed") return { kind: "completed", value: step.value };
  if (step.kind === "reconcile") return { kind: "reconcile", context: step.context };
  throw new Error("Desktop Runtime Host reconciled control returned an invalid step");
}
