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
import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type {
  DesktopTranscriptBatch,
  DesktopTranscriptBatchPayload,
  DesktopTranscriptFragment,
  DesktopTranscriptHandle,
} from '../../../preload/transcript-contract.js';
import { projectDesktopStoredMessage } from '../../../shared/desktop-session-projection.js';
import { parseDesktopSessionKey } from '../../../shared/runtime-host-identity.js';

/**
 * The Renderer's copy of one Session transcript, opened in history mode: it
 * only grows, by tail changes and by explicit `loadEarlier` reads.
 */
export interface DesktopTranscriptRangeController {
  readonly store: DesktopTranscriptRangeStore;
  ready(): Promise<void>;
  waitForDurableMessage(messageId: string, timeoutMs: number): Promise<boolean>;
  /** One budget of earlier history, or everything down to `throughSequence` in one answer. */
  loadEarlier(throughSequence?: number): Promise<void>;
  reload(): Promise<void>;
  observationChanged(phase: 'pending' | 'ready'): void;
  close(): Promise<void>;
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

/** The `open` a range controller takes, reading a Session's history through the bridge. */
export function openDesktopTranscriptHistory(
  open: MakaBridge['transcripts']['open'],
  sessionId: string,
  accept: (batch: DesktopTranscriptBatch) => void,
): (signal: AbortSignal, resumeFrom?: number) => Promise<DesktopTranscriptHandle> {
  return (signal, resumeFrom) => open(
    sessionId,
    (batch) => {
      if (!signal.aborted) accept(batch);
    },
    (cancel) => {
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    },
    'history',
    resumeFrom,
  );
}

export function createDesktopTranscriptRangeController(
  store: DesktopTranscriptRangeStore,
  /** `resumeFrom` is the oldest sequence held, which a reopen must read back down to. */
  open: (signal: AbortSignal, resumeFrom?: number) => Promise<DesktopTranscriptHandle>,
  options: { onError(error: unknown): void },
): DesktopTranscriptRangeController {
  let closed = false;
  let openController = new AbortController();
  let handle = open(openController.signal);
  const current = async () => {
    if (closed) throw new Error('Desktop transcript range is closed');
    return handle;
  };
  const range = () => {
    try {
      return store.range();
    } catch {
      return undefined;
    }
  };
  const cached = () => {
    const current = range();
    return current?.ready === true && current.generation.startsWith('cached:');
  };
  const requireLive = () => {
    if (cached()) throw new Error('The cached transcript is waiting for Host reconnection');
  };
  /** Main marks the Session read from these alone, so each watermark the reader reaches is reported once. */
  let acknowledged: number | undefined;
  const acknowledgeTail = () => {
    const held = range();
    if (!held?.ready || held.durableThrough === null || held.generation.startsWith('cached:')) return;
    const through = held.durableThrough;
    if (acknowledged === through) return;
    acknowledged = through;
    void (async () => {
      try {
        await (await current()).acknowledgeTail(through);
      } catch {
        if (acknowledged === through) acknowledged = undefined;
      }
    })();
  };
  const reopen = async () => {
    const previous = handle;
    acknowledged = undefined;
    openController.abort();
    const held = range();
    const resumeFrom = held?.ready ? held.oldestSequence ?? undefined : undefined;
    const replacement = previous
      .then((value) => value.close())
      .catch(() => undefined)
      .then(() => {
        if (closed) throw new Error('Desktop transcript range is closed');
        openController = new AbortController();
        return open(openController.signal, resumeFrom);
      });
    handle = replacement;
    await replacement;
    requireLive();
  };
  const recovery = createDesktopTranscriptReconnectRecovery({
    reload: reopen,
    onError(error) {
      if (!cached()) options.onError(error);
    },
  });
  // A reopen can land on the cached transcript; recovery must still hear of it.
  const reload = () => reopen().catch((error: unknown) => {
    recovery.transcriptFailed(error);
    throw error;
  });
  let gapReload: Promise<void> | undefined;
  const unsubscribe = store.subscribe(() => {
    acknowledgeTail();
    if (!store.needsReload() || gapReload || closed) return;
    gapReload = reload()
      .catch(() => undefined)
      .finally(() => { gapReload = undefined; });
  });
  void handle.then(requireLive).catch(recovery.transcriptFailed);
  let earlier: Promise<void> | undefined;
  const loadEarlier = (throughSequence?: number): Promise<void> => {
    if (earlier) {
      return throughSequence === undefined ? earlier : earlier.then(() => loadEarlier(throughSequence));
    }
    const held = range();
    if (!held?.ready || !held.hasOlder || cached()) return Promise.resolve();
    if (
      throughSequence !== undefined &&
      held.oldestSequence !== null &&
      held.oldestSequence <= throughSequence
    ) return Promise.resolve();
    const reading = handle;
    const task = current()
      .then((value) => value.loadEarlier(throughSequence))
      .catch((error: unknown) => {
        if (!closed && reading === handle) options.onError(error);
      })
      .finally(() => { earlier = undefined; });
    earlier = task;
    return task;
  };
  return {
    store,
    async ready() { await current(); },
    async waitForDurableMessage(messageId, timeoutMs) {
      await current();
      return store.waitForDurableMessage(messageId, timeoutMs);
    },
    loadEarlier,
    reload,
    observationChanged: recovery.observationChanged,
    async close() {
      if (closed) return;
      closed = true;
      recovery.close();
      unsubscribe();
      openController.abort();
      await handle.then((value) => value.close()).catch(() => undefined);
    },
  };
}

interface PendingRecord {
  readonly totalBytes: number;
  readonly bytes: Uint8Array;
  receivedBytes: number;
}

interface StoredRecord {
  readonly message: StoredMessage;
  readonly encoded: string;
}

export interface DesktopTranscriptRangeState {
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly durableThrough: number | null;
  readonly oldestSequence: number | null;
  /** Earlier durable history exists that the Renderer has not loaded. */
  readonly hasOlder: boolean;
  /**
   * Whether the oldest Turn held has all its rows. An answer is bounded by
   * bytes, so it can begin inside a Turn, and no local rule says that it did.
   */
  readonly beginsAtTurnBoundary: boolean;
  readonly ready: boolean;
}

export interface DesktopTranscriptRangeSnapshot extends DesktopTranscriptRangeState {
  readonly messages: readonly StoredMessage[];
}

/** An immutable transcript value: durable rows in sequence order. */
interface TranscriptValue {
  readonly rows: ReadonlyMap<number, StoredRecord>;
  readonly order: readonly number[];
  readonly hasOlder: boolean;
  readonly beginsAtTurnBoundary: boolean;
  readonly through: number | null;
}

/**
 * One answer under construction. Batches accumulate here so that the value
 * changes exactly once per answer, from one complete value to the next.
 */
interface TranscriptAssembly {
  readonly kind: 'reset' | 'earlier' | 'tail';
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly earlierThan: number | undefined;
  readonly coversFrom: number | null | undefined;
  durableThrough: number | null;
  hasOlder: boolean | undefined;
  beginsAtTurnBoundary: boolean | undefined;
  readonly fragments: Map<number, PendingRecord>;
  readonly rows: Map<number, StoredRecord>;
}

const EMPTY_VALUE: TranscriptValue = {
  rows: new Map(),
  order: [],
  hasOlder: false,
  beginsAtTurnBoundary: true,
  through: null,
};

export class DesktopTranscriptRangeStore {
  readonly sessionId: string;
  readonly #hostId: string;
  readonly #expectedSessionId: string;
  #value: TranscriptValue = EMPTY_VALUE;
  #assembly: TranscriptAssembly | undefined;
  readonly #retiredGenerations = new Set<string>();
  #sourceSessionId: string | undefined;
  #generation: string | undefined;
  #liveGeneration: string | undefined;
  #hostEpoch: string | undefined;
  #ready = false;
  #needsReload = false;
  #snapshot: DesktopTranscriptRangeSnapshot | undefined;
  readonly #durableWaiters = new Set<() => void>();
  readonly #listeners = new Set<() => void>();

  constructor(sessionKey: string) {
    const { hostId, sessionId } = parseDesktopSessionKey(sessionKey);
    this.sessionId = sessionKey;
    this.#hostId = hostId;
    this.#expectedSessionId = sessionId;
  }

  #accepts(batch: DesktopTranscriptBatchPayload): boolean {
    if (this.#retiredGenerations.has(batch.generation)) return false;
    if (batch.reset) return true;
    const identity = this.#assembly ?? {
      sessionId: this.#sourceSessionId,
      generation: this.#generation,
      hostEpoch: this.#hostEpoch,
    };
    return batch.sessionId === identity.sessionId &&
      batch.generation === identity.generation &&
      batch.hostEpoch === identity.hostEpoch;
  }

  accept(batch: DesktopTranscriptBatchPayload): boolean {
    if (!this.#accepts(batch)) return false;
    if (batch.reset && batch.sessionId !== this.#expectedSessionId) {
      throw new Error('Desktop transcript belongs to a different Session');
    }
    let assembly = batch.reset ? undefined : this.#assembly;
    if (!assembly) {
      assembly = {
        kind: batch.reset ? 'reset' : batch.earlierThan !== undefined ? 'earlier' : 'tail',
        sessionId: batch.sessionId,
        generation: batch.generation,
        hostEpoch: batch.hostEpoch,
        earlierThan: batch.earlierThan,
        coversFrom: batch.coversFrom,
        durableThrough: batch.durableThrough,
        hasOlder: undefined,
        beginsAtTurnBoundary: undefined,
        fragments: new Map(),
        rows: new Map(),
      };
      this.#assembly = assembly;
    }
    if (batch.hasOlder !== undefined) assembly.hasOlder = batch.hasOlder;
    if (batch.beginsAtTurnBoundary !== undefined) {
      assembly.beginsAtTurnBoundary = batch.beginsAtTurnBoundary;
    }
    assembly.durableThrough = batch.durableThrough;
    for (const fragment of batch.fragments) this.#acceptFragment(assembly, fragment);
    if (!batch.ready) return false;
    this.#assembly = undefined;
    return this.#apply(assembly);
  }

  #apply(answer: TranscriptAssembly): boolean {
    const value = this.#value;
    const wasReady = this.#ready;
    const next = this.#install(answer);
    if (next) {
      this.#value = next;
      if (answer.kind === 'reset') {
        this.#adoptHostIdentity(answer);
        this.#ready = true;
        this.#needsReload = false;
      }
    } else if (answer.kind === 'tail') {
      this.#needsReload = true;
    }
    const changed = this.#value !== value || this.#ready !== wasReady || (!next && answer.kind === 'tail');
    if (changed) this.#commit();
    for (const notify of this.#durableWaiters) notify();
    return changed;
  }

  /** The next value, or `undefined` where the answer does not continue what is held. */
  #install(answer: TranscriptAssembly): TranscriptValue | undefined {
    const value = this.#value;
    if (answer.kind === 'reset') {
      return makeValue(
        answer.rows,
        answer.hasOlder ?? false,
        answer.beginsAtTurnBoundary ?? true,
        answer.durableThrough,
      );
    }
    if (answer.kind === 'earlier') {
      if (!this.#ready || answer.earlierThan !== value.order[0]) return undefined;
      return makeValue(
        mergeRows(value.rows, answer.rows),
        answer.hasOlder ?? value.hasOlder,
        answer.beginsAtTurnBoundary ?? value.beginsAtTurnBoundary,
        value.through,
      );
    }
    if (!this.#ready || answer.coversFrom !== value.through) return undefined;
    return makeValue(
      mergeRows(value.rows, answer.rows),
      value.hasOlder,
      value.beginsAtTurnBoundary,
      answer.durableThrough ?? value.through,
    );
  }

  /** Set when a tail change did not continue what is held; the controller reopens. */
  needsReload(): boolean {
    return this.#needsReload;
  }

  /** Fires after every committed change to `snapshot()`. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #commit(): void {
    this.#snapshot = this.#createSnapshot();
    for (const listener of [...this.#listeners]) listener();
  }

  snapshot(): DesktopTranscriptRangeSnapshot {
    this.#snapshot ??= this.#createSnapshot();
    return this.#snapshot;
  }

  range(): DesktopTranscriptRangeState {
    if (!this.#sourceSessionId || !this.#generation || !this.#hostEpoch) {
      throw new Error('Desktop transcript range is not initialized');
    }
    return {
      sessionId: this.sessionId,
      generation: this.#generation,
      hostEpoch: this.#hostEpoch,
      durableThrough: this.#value.through,
      oldestSequence: this.#value.order[0] ?? null,
      // A cached snapshot cannot serve earlier reads; the live answer replaces
      // it rather than continuing it.
      hasOlder: this.#value.hasOlder && !this.#generation.startsWith('cached:'),
      beginsAtTurnBoundary: this.#value.beginsAtTurnBoundary,
      ready: this.#ready,
    };
  }

  hasDurableMessage(messageId: string): boolean {
    for (const record of this.#value.rows.values()) {
      if (record.message.id === messageId) return true;
    }
    return false;
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

  #adoptHostIdentity(
    batch: { readonly sessionId: string; readonly generation: string; readonly hostEpoch: string },
  ): void {
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
    this.#sourceSessionId = batch.sessionId;
    this.#generation = batch.generation;
    this.#hostEpoch = batch.hostEpoch;
  }

  #acceptFragment(assembly: TranscriptAssembly, fragment: DesktopTranscriptFragment): void {
    const sequence = fragment.sequence;
    let pending = assembly.fragments.get(sequence);
    if (!pending) {
      pending = {
        totalBytes: fragment.totalBytes,
        bytes: new Uint8Array(fragment.totalBytes),
        receivedBytes: 0,
      };
      assembly.fragments.set(sequence, pending);
    }
    if (pending.totalBytes !== fragment.totalBytes) {
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
    if (pending.receivedBytes < pending.totalBytes) return;
    assembly.fragments.delete(sequence);
    const encoded = new TextDecoder('utf-8', { fatal: true }).decode(pending.bytes);
    const message = freezeTranscriptValue(projectDesktopStoredMessage(
      { hostId: this.#hostId },
      decodeStoredMessage(markPersisted<StoredMessage>(JSON.parse(encoded))),
    ));
    assembly.rows.set(sequence, { message, encoded: JSON.stringify(message) });
  }

  #createSnapshot(): DesktopTranscriptRangeSnapshot {
    const range = this.range();
    const value = this.#value;
    const messages = Object.freeze(value.order.map((sequence) => value.rows.get(sequence)!.message));
    return Object.freeze({ ...range, messages });
  }
}

function mergeRows(
  current: ReadonlyMap<number, StoredRecord>,
  rows: ReadonlyMap<number, StoredRecord>,
): Map<number, StoredRecord> {
  const merged = new Map(current);
  for (const [sequence, record] of rows) {
    const existing = merged.get(sequence);
    if (existing && existing.encoded !== record.encoded) {
      throw new Error('Desktop transcript durable record changed');
    }
    merged.set(sequence, record);
  }
  return merged;
}

function makeValue(
  rows: ReadonlyMap<number, StoredRecord>,
  hasOlder: boolean,
  beginsAtTurnBoundary: boolean,
  through: number | null,
): TranscriptValue {
  return {
    rows,
    order: [...rows.keys()].sort((left, right) => left - right),
    hasOlder,
    beginsAtTurnBoundary,
    through,
  };
}

function freezeTranscriptValue<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeTranscriptValue(child);
  return Object.freeze(value);
}
