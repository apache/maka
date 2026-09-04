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

import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import { markPersisted } from '@maka/core/persisted-value';
import type {
  DesktopTranscriptBatchPayload,
  DesktopTranscriptFragment,
  DesktopTranscriptHandle,
} from '../preload/transcript-contract.js';
import { projectDesktopStoredMessage } from '../shared/desktop-session-projection.js';
import { parseDesktopSessionKey } from '../shared/runtime-host-identity.js';

export interface DesktopTranscriptRangeController {
  readonly store: DesktopTranscriptRangeStore;
  ready(): Promise<void>;
  waitForDurableMessage(messageId: string, timeoutMs: number): Promise<boolean>;
  loadBefore(maxBytes?: number, anchorTurnId?: string): Promise<void>;
  loadAround(sequence: number): Promise<void>;
  loadLatest(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

export function createDesktopTranscriptRangeController(
  store: DesktopTranscriptRangeStore,
  open: (signal: AbortSignal) => Promise<DesktopTranscriptHandle>,
): DesktopTranscriptRangeController {
  let closed = false;
  let openController = new AbortController();
  let handle = open(openController.signal);
  const current = async () => {
    if (closed) throw new Error('Desktop transcript range is closed');
    return handle;
  };
  return {
    store,
    async ready() {
      await current();
    },
    async waitForDurableMessage(messageId, timeoutMs) {
      await current();
      return store.waitForDurableMessage(messageId, timeoutMs);
    },
    async loadBefore(maxBytes, anchorTurnId) {
      const range = store.range();
      if (!range.hasOlder) return;
      await (await current()).loadBefore(
        anchorTurnId === undefined
          ? range.oldestSequence
          : store.sequenceForTurn(anchorTurnId) ?? range.oldestSequence,
        maxBytes,
      );
    },
    async loadAround(sequence) {
      await (await current()).loadAround(sequence);
    },
    async loadLatest() {
      const range = store.range();
      if (!range.hasNewer || range.durableThrough === null) return;
      await (await current()).loadAround(range.durableThrough);
    },
    async reload() {
      const previous = handle;
      openController.abort();
      handle = previous
        .then((value) => value.close())
        .catch(() => undefined)
        .then(() => {
          if (closed) throw new Error('Desktop transcript range is closed');
          openController = new AbortController();
          return open(openController.signal);
        });
      await handle;
    },
    async close() {
      if (closed) return;
      closed = true;
      openController.abort();
      await handle.then((value) => value.close()).catch(() => undefined);
    },
  };
}

export interface DesktopTranscriptReconnectRecovery {
  transcriptFailed(error: unknown): void;
  observationChanged(phase: 'pending' | 'ready'): void;
  close(): void;
}

export function createDesktopTranscriptReconnectRecovery(options: {
  reload(): Promise<void>;
  onError(error: unknown): void;
}): DesktopTranscriptReconnectRecovery {
  let closed = false;
  let observationReady = false;
  let readinessGeneration = 0;
  let needsRecovery = false;
  let recoveryTask: Promise<void> | undefined;

  const recover = () => {
    if (closed || !observationReady || !needsRecovery || recoveryTask) return;
    const admittedReadinessGeneration = readinessGeneration;
    needsRecovery = false;
    const task = Promise.resolve().then(async () => {
      try {
        if (closed) return;
        await options.reload();
      } catch (error) {
        if (closed) return;
        needsRecovery = true;
        options.onError(error);
      }
    });
    recoveryTask = task;
    const settle = () => {
      if (recoveryTask !== task) return;
      recoveryTask = undefined;
      if (
        needsRecovery
        && observationReady
        && readinessGeneration > admittedReadinessGeneration
      ) recover();
    };
    void task.then(settle, settle);
  };

  return {
    transcriptFailed(error) {
      if (closed) return;
      needsRecovery = true;
      options.onError(error);
      recover();
    },
    observationChanged(phase) {
      if (closed) return;
      if (phase === 'pending') {
        observationReady = false;
        return;
      }
      if (!observationReady) readinessGeneration += 1;
      observationReady = true;
      recover();
    },
    close() {
      closed = true;
      observationReady = false;
    },
  };
}

export interface RecoveringDesktopTranscriptRangeController
  extends DesktopTranscriptRangeController {
  observationChanged(phase: 'pending' | 'ready'): void;
}

export function createRecoveringDesktopTranscriptRangeController(
  store: DesktopTranscriptRangeStore,
  open: (signal: AbortSignal) => Promise<DesktopTranscriptHandle>,
  options: {
    onError(error: unknown): void;
  },
): RecoveringDesktopTranscriptRangeController {
  const controller = createDesktopTranscriptRangeController(store, open);
  const recovery = createDesktopTranscriptReconnectRecovery({
    reload: controller.reload,
    ...options,
  });
  void controller.ready().catch(recovery.transcriptFailed);
  return {
    ...controller,
    observationChanged: recovery.observationChanged,
    async close() {
      recovery.close();
      await controller.close();
    },
  };
}

interface PendingRecord {
  readonly source: 'durable' | 'overlay';
  readonly identity: number | string;
  readonly order: number | null;
  readonly totalBytes: number;
  readonly bytes: Uint8Array;
  receivedBytes: number;
}

interface StoredRecord {
  readonly message: StoredMessage;
  readonly encoded: string;
}

interface OverlayRecord extends StoredRecord {
  readonly order: number;
}

export interface DesktopTranscriptRangeState {
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly durableThrough: number | null;
  readonly oldestSequence: number | null;
  readonly newestSequence: number | null;
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly ready: boolean;
}

export interface DesktopTranscriptRangeSnapshot extends DesktopTranscriptRangeState {
  readonly messages: readonly StoredMessage[];
}

export class DesktopTranscriptRangeStore {
  readonly #sessionKey: string;
  readonly #hostId: string;
  readonly #expectedSessionId: string;
  readonly #durable = new Map<number, StoredRecord>();
  readonly #overlay = new Map<string, OverlayRecord>();
  readonly #durableOrder: number[] = [];
  readonly #overlayOrder: string[] = [];
  readonly #pending = new Map<string, PendingRecord>();
  #sourceSessionId: string | undefined;
  #generation: string | undefined;
  #hostEpoch: string | undefined;
  #durableThrough: number | null = null;
  #oldestSequence: number | null = null;
  #newestSequence: number | null = null;
  #newestUserSequence: number | null = null;
  #hasOlder = false;
  #hasNewer = false;
  #ready = false;
  #batchChanged = false;
  #snapshot: DesktopTranscriptRangeSnapshot | undefined;
  readonly #durableWaiters = new Set<() => void>();

  constructor(sessionKey: string) {
    const { hostId, sessionId } = parseDesktopSessionKey(sessionKey);
    this.#sessionKey = sessionKey;
    this.#hostId = hostId;
    this.#expectedSessionId = sessionId;
  }

  accept(batch: DesktopTranscriptBatchPayload): boolean {
    if (batch.reset) this.#reset(batch);
    if (
      batch.sessionId !== this.#sourceSessionId ||
      batch.generation !== this.#generation ||
      batch.hostEpoch !== this.#hostEpoch
    ) {
      return false;
    }
    let changed =
      batch.reset ||
      batch.durableThrough !== this.#durableThrough ||
      batch.hasOlder !== this.#hasOlder ||
      batch.hasNewer !== this.#hasNewer;
    this.#durableThrough = batch.durableThrough;
    this.#hasOlder = batch.hasOlder;
    this.#hasNewer = batch.hasNewer;
    for (const sequence of batch.evictedDurableSequences) {
      if (this.#durable.delete(sequence)) {
        removeOrdered(this.#durableOrder, sequence);
        this.#refreshSequenceBounds(sequence);
        changed = true;
      }
    }
    for (const messageId of batch.completedOverlayMessageIds) {
      if (this.#overlay.delete(messageId)) {
        removeOrdered(this.#overlayOrder, messageId);
        changed = true;
      }
    }
    for (const fragment of batch.fragments) {
      changed = this.#acceptFragment(fragment) || changed;
    }
    if (batch.ready && !this.#ready) {
      this.#ready = true;
      changed = true;
    }
    this.#batchChanged = this.#batchChanged || changed;
    if (!batch.ready) return false;
    const committed = this.#batchChanged;
    this.#batchChanged = false;
    if (committed) this.#snapshot = this.#createSnapshot();
    for (const notify of this.#durableWaiters) notify();
    return committed;
  }

  snapshot(): DesktopTranscriptRangeSnapshot {
    this.#snapshot ??= this.#createSnapshot();
    return this.#snapshot;
  }

  durableEntries(): ReadonlyArray<{ readonly sequence: number; readonly message: StoredMessage }> {
    return [...this.#durable.entries()]
      .sort(([left], [right]) => left - right)
      .map(([sequence, record]) => ({
        sequence,
        message: structuredClone(record.message),
      }));
  }

  range(): DesktopTranscriptRangeState {
    if (!this.#sourceSessionId || !this.#generation || !this.#hostEpoch) {
      throw new Error('Desktop transcript range is not initialized');
    }
    return {
      sessionId: this.#sessionKey,
      generation: this.#generation,
      hostEpoch: this.#hostEpoch,
      durableThrough: this.#durableThrough,
      oldestSequence: this.#oldestSequence,
      newestSequence: this.#newestSequence,
      hasOlder: this.#hasOlder,
      hasNewer: this.#hasNewer,
      ready: this.#ready,
    };
  }

  hasDurableMessage(messageId: string): boolean {
    for (const record of this.#durable.values()) {
      if (record.message.id === messageId) return true;
    }
    return false;
  }

  newestDurableUserSequence(): number | null {
    return this.#newestUserSequence;
  }

  sequenceForTurn(turnId: string): number | null {
    for (const sequence of this.#durableOrder) {
      if (this.#durable.get(sequence)?.message.turnId === turnId) return sequence;
    }
    return null;
  }

  waitForDurableMessage(messageId: string, timeoutMs: number): Promise<boolean> {
    if (this.hasDurableMessage(messageId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (found: boolean) => {
        globalThis.clearTimeout(timeout);
        this.#durableWaiters.delete(check);
        resolve(found);
      };
      const check = () => {
        if (this.hasDurableMessage(messageId)) finish(true);
      };
      const timeout = globalThis.setTimeout(() => finish(false), timeoutMs);
      this.#durableWaiters.add(check);
      check();
    });
  }

  #reset(batch: DesktopTranscriptBatchPayload): void {
    if (batch.sessionId !== this.#expectedSessionId) {
      throw new Error('Desktop transcript belongs to a different Session');
    }
    this.#durable.clear();
    this.#overlay.clear();
    this.#durableOrder.length = 0;
    this.#overlayOrder.length = 0;
    this.#pending.clear();
    this.#sourceSessionId = batch.sessionId;
    this.#generation = batch.generation;
    this.#hostEpoch = batch.hostEpoch;
    this.#durableThrough = batch.durableThrough;
    this.#oldestSequence = null;
    this.#newestSequence = null;
    this.#newestUserSequence = null;
    this.#hasOlder = batch.hasOlder;
    this.#hasNewer = batch.hasNewer;
    this.#ready = false;
    this.#batchChanged = false;
    this.#snapshot = undefined;
  }

  #acceptFragment(fragment: DesktopTranscriptFragment): boolean {
    const key = `${fragment.source}:${typeof fragment.identity}:${fragment.identity}`;
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = {
        source: fragment.source,
        identity: fragment.identity,
        order: fragment.order,
        totalBytes: fragment.totalBytes,
        bytes: new Uint8Array(fragment.totalBytes),
        receivedBytes: 0,
      };
      this.#pending.set(key, pending);
    }
    if (
      pending.source !== fragment.source ||
      pending.identity !== fragment.identity ||
      pending.order !== fragment.order ||
      pending.totalBytes !== fragment.totalBytes
    ) {
      throw new Error('Desktop transcript fragment identity changed');
    }
    const bytes = fragment.data;
    if (
      fragment.byteOffset < 0 ||
      fragment.byteOffset + bytes.byteLength > fragment.totalBytes
    ) {
      throw new Error('Desktop transcript fragment is outside its record');
    }
    if (fragment.byteOffset !== pending.receivedBytes) {
      throw new Error('Desktop transcript record has a fragment gap');
    }
    pending.bytes.set(bytes, fragment.byteOffset);
    pending.receivedBytes += bytes.byteLength;
    if (pending.receivedBytes < pending.totalBytes) return false;
    const encoded = new TextDecoder('utf-8', { fatal: true }).decode(pending.bytes);
    const message = freezeTranscriptValue(projectDesktopStoredMessage(
      { hostId: this.#hostId },
      decodeStoredMessage(markPersisted<StoredMessage>(JSON.parse(encoded))),
    ));
    const projected = JSON.stringify(message);
    this.#pending.delete(key);
    if (pending.source === 'durable') {
      if (!Number.isSafeInteger(pending.identity) || (pending.identity as number) < 0) {
        throw new Error('Invalid Desktop transcript durable identity');
      }
      const sequence = pending.identity as number;
      const existing = this.#durable.get(sequence);
      if (existing && existing.encoded !== projected) {
        throw new Error('Desktop transcript durable record changed');
      }
      if (existing) return false;
      this.#durable.set(sequence, { message, encoded: projected });
      insertOrdered(this.#durableOrder, sequence, (left, right) => left - right);
      this.#oldestSequence = Math.min(this.#oldestSequence ?? sequence, sequence);
      this.#newestSequence = Math.max(this.#newestSequence ?? sequence, sequence);
      if (message.type === 'user') {
        this.#newestUserSequence = Math.max(this.#newestUserSequence ?? sequence, sequence);
      }
      return !existing;
    }
    if (typeof pending.identity !== 'string' || message.id !== pending.identity) {
      throw new Error('Desktop transcript overlay identity changed');
    }
    if (pending.order === null || !Number.isSafeInteger(pending.order) || pending.order < 0) {
      throw new Error('Invalid Desktop transcript overlay order');
    }
    const existing = this.#overlay.get(pending.identity);
    if (
      existing
      && existing.encoded === projected
      && existing.order === pending.order
    ) {
      return false;
    }
    if (existing) removeOrdered(this.#overlayOrder, pending.identity);
    this.#overlay.set(pending.identity, {
      message,
      encoded: projected,
      order: pending.order,
    });
    insertOrdered(
      this.#overlayOrder,
      pending.identity,
      (left, right) => {
        const order = this.#overlay.get(left)!.order - this.#overlay.get(right)!.order;
        return order === 0 ? left.localeCompare(right) : order;
      },
    );
    return true;
  }

  #refreshSequenceBounds(deletedSequence: number): void {
    if (deletedSequence !== this.#oldestSequence && deletedSequence !== this.#newestSequence) return;
    this.#oldestSequence = this.#durableOrder[0] ?? null;
    this.#newestSequence = this.#durableOrder.at(-1) ?? null;
  }

  #createSnapshot(): DesktopTranscriptRangeSnapshot {
    const messages = Object.freeze([
      ...this.#durableOrder.map((sequence) => this.#durable.get(sequence)!.message),
      ...this.#overlayOrder.map((messageId) => this.#overlay.get(messageId)!.message),
    ]);
    return Object.freeze({
      ...this.range(),
      messages,
    });
  }
}

function freezeTranscriptValue<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeTranscriptValue(child);
  return Object.freeze(value);
}

function insertOrdered<T>(
  items: T[],
  value: T,
  compare: (left: T, right: T) => number,
): void {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(items[middle]!, value) <= 0) low = middle + 1;
    else high = middle;
  }
  items.splice(low, 0, value);
}

function removeOrdered<T>(items: T[], value: T): void {
  const index = items.indexOf(value);
  if (index >= 0) items.splice(index, 1);
}
