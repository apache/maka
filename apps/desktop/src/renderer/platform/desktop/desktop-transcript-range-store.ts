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
import {
  DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  type DesktopTranscriptBatchPayload,
  type DesktopTranscriptFragment,
  type DesktopTranscriptHandle,
  type DesktopTranscriptWindowRead,
} from '../../../preload/transcript-contract.js';
import { projectDesktopStoredMessage } from '../../../shared/desktop-session-projection.js';
import { parseDesktopSessionKey } from '../../../shared/runtime-host-identity.js';

/**
 * The Renderer's window onto one Session transcript. `loadAround` and
 * `loadLatest` replace the window and mint a navigation version; `loadBefore`
 * and `loadAfter` extend it under the current version. Main answers the
 * request and otherwise only broadcasts tail growth.
 */
export interface DesktopTranscriptRangeController {
  readonly store: DesktopTranscriptRangeStore;
  ready(): Promise<void>;
  waitForDurableMessage(messageId: string, timeoutMs: number): Promise<boolean>;
  loadBefore(maxBytes?: number): Promise<void>;
  loadAfter(maxBytes?: number): Promise<void>;
  loadAround(sequence: number, maxBytes?: number): Promise<void>;
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
  const extending: {
    older?: { epoch: number; task: Promise<void> };
    newer?: { epoch: number; task: Promise<void> };
  } = {};
  const current = async () => {
    if (closed) throw new Error('Desktop transcript range is closed');
    return handle;
  };
  const command = async (
    replace: boolean,
    run: (value: DesktopTranscriptHandle, navigation: DesktopTranscriptWindowRead) => Promise<void>,
  ) => {
    // Mint before awaiting an open handle or any in-flight page.
    const windowEpoch = replace ? store.replaceWindow() : store.windowEpoch();
    const opening = handle;
    // A navigation outlives the band trimming the window under it; it is only
    // the next navigation that makes this one obsolete.
    const epoch = replace ? () => store.navigationEpoch() : () => store.windowEpoch();
    const isCurrent = () => !closed && epoch() === windowEpoch && opening === handle;
    try {
      const value = await current();
      if (!isCurrent()) return;
      await run(value, { windowEpoch });
    } catch (error) {
      if (isCurrent()) throw error;
    }
  };
  const extend = (edge: 'older' | 'newer', maxBytes: number): Promise<void> => {
    let range: DesktopTranscriptRangeState;
    try {
      range = store.range();
    } catch {
      return Promise.resolve();
    }
    // Sharing a read only holds while the window it was anchored on does.
    const pending = extending[edge];
    if (pending && pending.epoch === store.windowEpoch()) return pending.task;
    if (edge === 'older' ? !range.hasOlder : !range.hasNewer) return Promise.resolve();
    const anchor = edge === 'older' ? range.oldestSequence : range.newestSequence;
    const epoch = store.windowEpoch();
    const task = command(false, (value, navigation) =>
      edge === 'older'
        ? value.loadBefore(anchor, maxBytes, navigation)
        : value.loadAfter(anchor, maxBytes, navigation),
    ).finally(() => {
      if (extending[edge]?.task === task) extending[edge] = undefined;
    });
    extending[edge] = { epoch, task };
    return task;
  };
  return {
    store,
    async ready() { await current(); },
    async waitForDurableMessage(messageId, timeoutMs) {
      await current();
      return store.waitForDurableMessage(messageId, timeoutMs);
    },
    loadBefore(maxBytes = DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES) {
      return extend('older', maxBytes);
    },
    loadAfter(maxBytes = DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES) {
      return extend('newer', maxBytes);
    },
    loadAround(sequence, maxBytes = DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES) {
      return command(true, (value, navigation) => value.loadAround(sequence, maxBytes, navigation));
    },
    loadLatest() {
      return command(true, (value, navigation) => value.loadLatest(navigation));
    },
    async reload() {
      const previous = handle;
      openController.abort();
      const replacement = previous
        .then((value) => value.close())
        .catch(() => undefined)
        .then(() => {
          if (closed) throw new Error('Desktop transcript range is closed');
          openController = new AbortController();
          return open(openController.signal);
        });
      handle = replacement;
      await replacement;
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
  let attemptedReadinessGeneration = -1;
  let needsRecovery = false;
  let recoveryTask: Promise<void> | undefined;

  const recover = () => {
    if (closed || !observationReady || !needsRecovery || recoveryTask ||
      attemptedReadinessGeneration === readinessGeneration) return;
    const admittedReadinessGeneration = readinessGeneration;
    attemptedReadinessGeneration = admittedReadinessGeneration;
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
  const cached = () => {
    try {
      const range = store.range();
      return range.ready && range.generation.startsWith('cached:');
    } catch {
      return false;
    }
  };
  const requireLive = () => {
    if (cached()) throw new Error('The cached transcript is waiting for Host reconnection');
  };
  const recovery = createDesktopTranscriptReconnectRecovery({
    async reload() {
      await controller.reload();
      requireLive();
    },
    onError(error) {
      if (!cached()) options.onError(error);
    },
  });
  void controller.ready().then(requireLive).catch(recovery.transcriptFailed);
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
  readonly sessionId: string;
  readonly #hostId: string;
  readonly #expectedSessionId: string;
  readonly #durable = new Map<number, StoredRecord>();
  readonly #overlay = new Map<string, OverlayRecord>();
  readonly #durableOrder: number[] = [];
  readonly #overlayOrder: string[] = [];
  readonly #pending = new Map<string, PendingRecord>();
  #mintedEpoch = 0;
  #windowEpoch = 0;
  #navigationEpoch = 0;
  readonly #retiredGenerations = new Set<string>();
  #sourceSessionId: string | undefined;
  #generation: string | undefined;
  #liveGeneration: string | undefined;
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
  readonly #listeners = new Set<() => void>();

  constructor(sessionKey: string) {
    const { hostId, sessionId } = parseDesktopSessionKey(sessionKey);
    this.sessionId = sessionKey;
    this.#hostId = hostId;
    this.#expectedSessionId = sessionId;
  }

  windowEpoch(): number {
    return this.#windowEpoch;
  }

  navigationEpoch(): number {
    return this.#navigationEpoch;
  }

  /**
   * Mints the epoch for a window about to be replaced wholesale by a navigation,
   * and drops the partially received records of the window being left behind.
   */
  replaceWindow(): number {
    this.#navigationEpoch = this.#mintWindow();
    return this.#navigationEpoch;
  }

  /**
   * The window a read must name to be spliced onto. A navigation's answer takes
   * this back to the epoch it was issued under (see `#reset`), so the counter is
   * kept apart from it: a number, once minted, names one window forever, and a
   * read still in flight under a later one stays refusable.
   */
  #mintWindow(): number {
    this.#mintedEpoch += 1;
    this.#windowEpoch = this.#mintedEpoch;
    this.#pending.clear();
    this.#batchChanged = false;
    return this.#windowEpoch;
  }

  /**
   * A read is answerable only while what it assumed still holds, and the two
   * kinds of read assume different things.
   *
   * An extension splices rows onto one edge, so it assumes that edge: any
   * replacement of the window — navigating away, or the band trimming the edge
   * out — leaves its answer unable to reach what is left, and no edge cursor
   * can name the hole it would open. A replacement assumes nothing about the
   * edges, because it discards them; only a newer navigation makes it stale.
   *
   * Batches that name no epoch answer nothing: tail broadcasts apply to
   * whatever the window holds, and a snapshot replacing the transcript
   * underneath every window is not this window's answer to refuse.
   */
  accepts(batch: DesktopTranscriptBatchPayload): boolean {
    if (this.#retiredGenerations.has(batch.generation)) return false;
    if (batch.reset) {
      return batch.windowEpoch === undefined || batch.windowEpoch === this.#navigationEpoch;
    }
    if (batch.windowEpoch !== undefined && batch.windowEpoch !== this.#windowEpoch) return false;
    return batch.sessionId === this.#sourceSessionId &&
      batch.generation === this.#generation &&
      batch.hostEpoch === this.#hostEpoch;
  }

  accept(batch: DesktopTranscriptBatchPayload): boolean {
    if (!this.accepts(batch)) return false;
    if (batch.reset) this.#reset(batch);
    let changed = batch.reset;
    const answersCommand = batch.windowEpoch !== undefined;
    if (batch.hasOlder !== undefined && batch.hasOlder !== this.#hasOlder) {
      this.#hasOlder = batch.hasOlder;
      changed = true;
    }
    if (batch.hasNewer !== undefined) {
      // A page read before the tail grew cannot close the window's newer edge;
      // the rows that landed meanwhile were dropped below, so ask again.
      const hasNewer = batch.hasNewer ||
        (batch.durableThrough !== null && this.#durableThrough !== null &&
          batch.durableThrough < this.#durableThrough);
      if (hasNewer !== this.#hasNewer) {
        this.#hasNewer = hasNewer;
        changed = true;
      }
    }
    if (batch.durableThrough !== null &&
      (this.#durableThrough === null || batch.durableThrough > this.#durableThrough)) {
      this.#durableThrough = batch.durableThrough;
      changed = true;
    }
    // Tail growth belongs to the window only while the window reaches the tail.
    const installDurable = answersCommand || !this.#hasNewer;
    for (const fragment of batch.fragments) {
      changed = this.#acceptFragment(fragment, installDurable) || changed;
    }
    if (batch.ready && !this.#ready) {
      this.#ready = true;
      changed = true;
    }
    this.#batchChanged = this.#batchChanged || changed;
    if (!batch.ready) return false;
    const committed = this.#batchChanged;
    this.#batchChanged = false;
    if (committed) this.#commit();
    for (const notify of this.#durableWaiters) notify();
    return committed;
  }

  /** Fires after every committed change to `snapshot()`. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /**
   * Drops durable rows outside `[oldestSequence, newestSequence]`. Either edge
   * that lost rows becomes a history edge again.
   *
   * Dropping an edge mints a window epoch: an extension still in flight was
   * anchored on that edge, and installing its answer would leave rows missing
   * between the answer and what is left — a hole no edge cursor names and no
   * later page can fill.
   */
  retain(oldestSequence: number | null, newestSequence: number | null): boolean {
    let changed = false;
    for (const sequence of [...this.#durableOrder]) {
      const older = oldestSequence !== null && sequence < oldestSequence;
      const newer = newestSequence !== null && sequence > newestSequence;
      if (!older && !newer) continue;
      this.#durable.delete(sequence);
      removeOrdered(this.#durableOrder, sequence);
      if (older) this.#hasOlder = true;
      else this.#hasNewer = true;
      changed = true;
    }
    if (!changed) return false;
    this.#mintWindow();
    this.#oldestSequence = this.#durableOrder[0] ?? null;
    this.#newestSequence = this.#durableOrder.at(-1) ?? null;
    this.#newestUserSequence = null;
    for (const sequence of this.#durableOrder) {
      if (this.#durable.get(sequence)?.message.type === 'user') this.#newestUserSequence = sequence;
    }
    this.#commit();
    return true;
  }

  #commit(): void {
    this.#snapshot = this.#createSnapshot();
    for (const listener of [...this.#listeners]) listener();
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
      sessionId: this.sessionId,
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

  sequenceForTurn(turnId: string, edge: 'first' | 'last' = 'first'): number | null {
    const order = edge === 'first' ? this.#durableOrder : [...this.#durableOrder].reverse();
    return order.find((sequence) => this.#durable.get(sequence)?.message.turnId === turnId) ?? null;
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
    if (this.#generation?.startsWith('cached:') && this.#generation !== batch.generation) {
      this.#retiredGenerations.add(this.#generation);
    }
    // Cached resets are provisional; only a new live replica retires the previous one.
    if (!batch.generation.startsWith('cached:')) {
      if (this.#liveGeneration && this.#liveGeneration !== batch.generation) {
        this.#retiredGenerations.add(this.#liveGeneration);
      }
      this.#liveGeneration = batch.generation;
    }
    // The window this navigation was issued under is the window it installs,
    // however many epochs the band minted while it was outstanding: it discards
    // the edges those trims were protecting. Its remaining fragments extend it.
    if (batch.windowEpoch !== undefined) this.#windowEpoch = batch.windowEpoch;
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
    this.#hasOlder = batch.hasOlder ?? false;
    this.#hasNewer = batch.hasNewer ?? false;
    this.#ready = false;
    this.#batchChanged = false;
    this.#snapshot = undefined;
  }

  #acceptFragment(fragment: DesktopTranscriptFragment, installDurable: boolean): boolean {
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
    this.#pending.delete(key);
    // A declined row could still be the durable body of a message this window
    // is showing as an overlay, which only its id can tell us.
    if (pending.source === 'durable' && !installDurable && this.#overlay.size === 0) return false;
    const encoded = new TextDecoder('utf-8', { fatal: true }).decode(pending.bytes);
    const message = freezeTranscriptValue(projectDesktopStoredMessage(
      { hostId: this.#hostId },
      decodeStoredMessage(markPersisted<StoredMessage>(JSON.parse(encoded))),
    ));
    const projected = JSON.stringify(message);
    if (pending.source === 'durable') {
      if (!Number.isSafeInteger(pending.identity) || (pending.identity as number) < 0) {
        throw new Error('Invalid Desktop transcript durable identity');
      }
      const overlaid = this.#overlay.has(message.id);
      if (!installDurable && !overlaid) return false;
      const sequence = pending.identity as number;
      const existing = this.#durable.get(sequence);
      if (existing && existing.encoded !== projected) {
        throw new Error('Desktop transcript durable record changed');
      }
      // The durable row retires the overlay it settles, in the same step: a
      // window that keeps one without the other loses the message.
      if (overlaid) {
        this.#overlay.delete(message.id);
        removeOrdered(this.#overlayOrder, message.id);
      }
      if (existing) return overlaid;
      this.#durable.set(sequence, { message, encoded: projected });
      insertOrdered(this.#durableOrder, sequence, (left, right) => left - right);
      this.#oldestSequence = Math.min(this.#oldestSequence ?? sequence, sequence);
      this.#newestSequence = Math.max(this.#newestSequence ?? sequence, sequence);
      if (message.type === 'user') {
        this.#newestUserSequence = Math.max(this.#newestUserSequence ?? sequence, sequence);
      }
      return true;
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
