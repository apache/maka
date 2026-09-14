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
  DESKTOP_TRANSCRIPT_HOST_EPOCH_CHANGED_CODE,
  type DesktopTranscriptBatchPayload,
  type DesktopTranscriptExtension,
  type DesktopTranscriptFragment,
  type DesktopTranscriptHandle,
} from '../../../preload/transcript-contract.js';
import { TranscriptReadSupersededError } from '../../features/conversation/index.js';
import { projectDesktopStoredMessage } from '../../../shared/desktop-session-projection.js';
import { parseDesktopSessionKey } from '../../../shared/runtime-host-identity.js';

/**
 * The Renderer's window onto one Session transcript. `loadAround` and
 * `loadLatest` replace the window and mint a navigation number; `loadBefore`
 * and `loadAfter` extend it from an edge. Main answers the request and
 * otherwise only broadcasts tail growth.
 */
export interface DesktopTranscriptRangeController {
  readonly store: DesktopTranscriptRangeStore;
  ready(): Promise<void>;
  waitForDurableMessage(messageId: string, timeoutMs: number): Promise<boolean>;
  /** Resolves to whether a read was actually issued. */
  loadBefore(maxBytes?: number): Promise<boolean>;
  loadAfter(maxBytes?: number): Promise<boolean>;
  loadAround(sequence: number, maxBytes?: number): Promise<void>;
  loadLatest(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

/**
 * `acknowledgesTail` is what a reader that renders the transcript says about
 * itself. A consumer opened only to project rows reaches the tail just as a
 * reader does, and acknowledging from there would mark the Session read on
 * behalf of nobody, so the default is to stay silent.
 */
export function createDesktopTranscriptRangeController(
  store: DesktopTranscriptRangeStore,
  open: (signal: AbortSignal) => Promise<DesktopTranscriptHandle>,
  options: { readonly acknowledgesTail?: boolean } = {},
): DesktopTranscriptRangeController {
  let closed = false;
  let openController = new AbortController();
  let handle = open(openController.signal);
  const extending: {
    older?: { anchor: number | null; task: Promise<void> };
    newer?: { anchor: number | null; task: Promise<void> };
  } = {};
  /** The window a read was issued against; the same window answers the same way. */
  const spent: { older?: object; newer?: object } = {};
  const current = async () => {
    if (closed) throw new Error('Desktop transcript range is closed');
    return handle;
  };
  const command = async (
    replace: boolean,
    run: (value: DesktopTranscriptHandle, navigation: number) => Promise<void>,
  ) => {
    // Mint before awaiting an open handle or any in-flight page. Main uses the
    // number only to cancel work a newer navigation has made pointless, so an
    // extension issued while a navigation is still in flight names that
    // navigation: it is the one Main is already reading for.
    const navigation = replace ? store.navigate() : store.pendingNavigation() ?? store.navigation();
    const opening = handle;
    const isCurrent = () => !closed && opening === handle &&
      (!replace || store.pendingNavigation() === navigation);
    try {
      const value = await current();
      if (!isCurrent()) return;
      await run(value, navigation);
    } catch (error) {
      if (isCurrent()) throw error;
    }
  };
  /** The row a read at this edge would anchor on, or undefined with no edge to read. */
  const edgeAt = (edge: 'older' | 'newer'): { anchor: number | null } | undefined => {
    let range: DesktopTranscriptRangeState;
    try {
      range = store.range();
    } catch {
      return undefined;
    }
    if (edge === 'older' ? !range.hasOlder : !range.hasNewer) return undefined;
    return { anchor: edge === 'older' ? range.oldestSequence : range.newestSequence };
  };
  const extend = async (edge: 'older' | 'newer', maxBytes: number): Promise<boolean> => {
    const at = edgeAt(edge);
    if (!at) return false;
    // Sharing a read only holds while the edge it was anchored on does.
    const pending = extending[edge];
    if (pending && pending.anchor === at.anchor) {
      await pending.task;
      return false;
    }
    // A read issued against this exact window answers it the same way again.
    // Every commit mints a fresh snapshot object, so a window that moved at all
    // — by a page, a trim, a navigation or tail growth — is worth asking again.
    const window = store.snapshot();
    if (spent[edge] === window) return false;
    spent[edge] = window;
    const task = command(false, (value, navigation) =>
      edge === 'older'
        ? value.loadBefore(at.anchor, maxBytes, navigation)
        : value.loadAfter(at.anchor, maxBytes, navigation),
    ).finally(() => {
      if (extending[edge]?.task === task) extending[edge] = undefined;
    });
    extending[edge] = { anchor: at.anchor, task };
    await task;
    return true;
  };
  /**
   * Main marks the Session read from these and from nothing else, so the window
   * reports every watermark it actually reaches, once. A window with newer
   * history beyond it reports nothing: the reader is parked off the tail.
   */
  let acknowledged: number | undefined;
  const acknowledgeTail = () => {
    let range: DesktopTranscriptRangeState;
    try {
      range = store.range();
    } catch {
      return;
    }
    // A cached window's watermark is a fact about the local cache, not about
    // the live replica an acknowledgement moves.
    if (
      !range.ready || range.hasNewer || range.durableThrough === null ||
      range.generation.startsWith('cached:')
    ) return;
    const through = range.durableThrough;
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
  const unsubscribe = options.acknowledgesTail ? store.subscribe(acknowledgeTail) : () => {};
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
      // The replacement consumer has heard nothing yet.
      acknowledged = undefined;
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
      unsubscribe();
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

function isHostEpochChanged(error: unknown): error is Error {
  return error instanceof Error &&
    error.message.includes(`${DESKTOP_TRANSCRIPT_HOST_EPOCH_CHANGED_CODE}:`);
}

export function createRecoveringDesktopTranscriptRangeController(
  store: DesktopTranscriptRangeStore,
  open: (signal: AbortSignal) => Promise<DesktopTranscriptHandle>,
  options: {
    onError(error: unknown): void;
  },
): RecoveringDesktopTranscriptRangeController {
  // Every visible transcript reader recovers; a projection does not. So this is
  // the one place that claims tail acknowledgement on a reader's behalf.
  const controller = createDesktopTranscriptRangeController(store, open, { acknowledgesTail: true });
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
  /**
   * A read the Host refused because its epoch moved under the request says
   * nothing about the reader: the replacement replica has already asked every
   * consumer to reset, and that reset carries the new epoch, so reopening here
   * would only throw the answer away. Retype it so the reading position treats
   * the read as superseded instead of failed.
   */
  const superseding = <T>(run: () => Promise<T>): Promise<T> => run().catch((error: unknown) => {
    if (!isHostEpochChanged(error)) throw error;
    throw new TranscriptReadSupersededError(error.message, { cause: error });
  });
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
    loadBefore: (maxBytes) => superseding(() => controller.loadBefore(maxBytes)),
    loadAfter: (maxBytes) => superseding(() => controller.loadAfter(maxBytes)),
    loadAround: (sequence, maxBytes) => superseding(() => controller.loadAround(sequence, maxBytes)),
    loadLatest: () => superseding(() => controller.loadLatest()),
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

/**
 * An immutable window value. `through` is the newer-side watermark the Host has
 * proved this window reaches; `hasNewerAtThrough` says whether rows at or below
 * it are still missing, which no watermark comparison can tell.
 */
interface TranscriptWindow {
  readonly rows: ReadonlyMap<number, StoredRecord>;
  readonly order: readonly number[];
  readonly hasOlder: boolean;
  readonly through: number | null;
  readonly hasNewerAtThrough: boolean;
  readonly newestUserSequence: number | null;
}

/** The Host tail, which is not a window member: the view shows it only at the tail. */
interface TranscriptTail {
  readonly through: number | null;
  readonly overlay: ReadonlyMap<string, OverlayRecord>;
  readonly overlayOrder: readonly string[];
}

/**
 * One answer under construction. Batches accumulate here so that `#window`
 * changes exactly once per answer, from one complete value to the next.
 */
interface TranscriptAssembly {
  readonly kind: 'replace' | 'extend' | 'tail';
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly navigation: number | undefined;
  readonly extension: DesktopTranscriptExtension | undefined;
  readonly coversFrom: number | null | undefined;
  /** Decided once: rows the window cannot join are not worth decoding. */
  readonly collects: boolean;
  durableThrough: number | null;
  hasOlder: boolean | undefined;
  hasNewer: boolean | undefined;
  readonly fragments: Map<string, PendingRecord>;
  readonly rows: Map<number, StoredRecord>;
  readonly overlay: Map<string, OverlayRecord>;
}

const EMPTY_WINDOW: TranscriptWindow = {
  rows: new Map(),
  order: [],
  hasOlder: false,
  through: null,
  hasNewerAtThrough: false,
  newestUserSequence: null,
};

const EMPTY_TAIL: TranscriptTail = { through: null, overlay: new Map(), overlayOrder: [] };

export class DesktopTranscriptRangeStore {
  readonly sessionId: string;
  readonly #hostId: string;
  readonly #expectedSessionId: string;
  #window: TranscriptWindow = EMPTY_WINDOW;
  #tail: TranscriptTail = EMPTY_TAIL;
  #assembly: TranscriptAssembly | undefined;
  #pendingNavigation: number | undefined;
  #navigations = 0;
  readonly #retiredGenerations = new Set<string>();
  #sourceSessionId: string | undefined;
  #generation: string | undefined;
  #liveGeneration: string | undefined;
  #hostEpoch: string | undefined;
  #ready = false;
  #snapshot: DesktopTranscriptRangeSnapshot | undefined;
  readonly #durableWaiters = new Set<() => void>();
  readonly #listeners = new Set<() => void>();

  constructor(sessionKey: string) {
    const { hostId, sessionId } = parseDesktopSessionKey(sessionKey);
    this.sessionId = sessionKey;
    this.#hostId = hostId;
    this.#expectedSessionId = sessionId;
  }

  /** Names the replacement a navigation is about to ask for. */
  navigate(): number {
    this.#navigations += 1;
    this.#pendingNavigation = this.#navigations;
    return this.#pendingNavigation;
  }

  /** The replacement that has been asked for and has not landed yet. */
  pendingNavigation(): number | undefined {
    return this.#pendingNavigation;
  }

  /** The navigation the window currently sits on. */
  navigation(): number {
    return this.#navigations;
  }

  /**
   * Whether this batch is worth assembling at all. Only Host identity decides
   * that; whether its rows reach the window is settled once the whole answer is
   * in hand, against the anchor the answer carries.
   */
  #accepts(batch: DesktopTranscriptBatchPayload): boolean {
    if (this.#retiredGenerations.has(batch.generation)) return false;
    if (batch.reset) {
      return batch.navigation === undefined || batch.navigation === this.#pendingNavigation;
    }
    // A continuation belongs to the answer in flight, whose identity the
    // window only adopts once that answer lands.
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
    let assembly = this.#assembly;
    // A reset is by construction the first batch of its answer, so it starts a
    // fresh one even where its identity matches what is in flight.
    if (assembly && (batch.reset || !continuesAssembly(assembly, batch))) assembly = undefined;
    if (!assembly) {
      const kind = batch.reset ? 'replace' : batch.extends ? 'extend' : 'tail';
      assembly = {
        kind,
        sessionId: batch.sessionId,
        generation: batch.generation,
        hostEpoch: batch.hostEpoch,
        navigation: batch.navigation,
        extension: batch.extends,
        coversFrom: batch.coversFrom,
        // A tail answer this window cannot join contributes nothing but its
        // watermark, unless an overlay row is waiting to learn it has settled.
        collects: kind !== 'tail' ||
          this.#tail.overlay.size > 0 ||
          this.#joinsTail(batch.coversFrom),
        durableThrough: batch.durableThrough,
        hasOlder: undefined,
        hasNewer: undefined,
        fragments: new Map(),
        rows: new Map(),
        overlay: new Map(),
      };
      this.#assembly = assembly;
    }
    if (batch.hasOlder !== undefined) assembly.hasOlder = batch.hasOlder;
    if (batch.hasNewer !== undefined) assembly.hasNewer = batch.hasNewer;
    assembly.durableThrough = batch.durableThrough;
    for (const fragment of batch.fragments) this.#acceptFragment(assembly, fragment, assembly.collects);
    if (!batch.ready) return false;
    this.#assembly = undefined;
    return this.#apply(assembly);
  }

  /**
   * Installs one complete answer. The Host facts it carries land whatever the
   * window does with its rows; the rows land only where the answer's anchor is
   * still the edge it was read from, because nothing else proves them adjacent.
   */
  #apply(answer: TranscriptAssembly): boolean {
    const tail = this.#tail;
    const window = this.#window;
    let overlay = answer.kind === 'replace' ? answer.overlay : tail.overlay;
    let overlayOrder = answer.kind === 'replace' ? orderOverlay(answer.overlay) : tail.overlayOrder;
    // A durable row retires the overlay it settles, whether or not this window
    // keeps the row: seeing it is what proves the overlay obsolete.
    if (overlay.size > 0) {
      const settled = new Map(overlay);
      for (const record of answer.rows.values()) settled.delete(record.message.id);
      if (settled.size !== overlay.size) {
        overlay = settled;
        overlayOrder = overlayOrder.filter((messageId) => settled.has(messageId));
      }
    }
    const through = answer.durableThrough !== null &&
      (tail.through === null || answer.durableThrough > tail.through)
      ? answer.durableThrough
      : tail.through;
    if (through !== tail.through || overlay !== tail.overlay) {
      this.#tail = { through, overlay, overlayOrder };
    }
    const installed = this.#install(answer);
    if (installed) this.#window = installed;
    if (installed && answer.kind === 'replace') this.#adoptHostIdentity(answer);
    if (answer.navigation !== undefined && answer.navigation === this.#pendingNavigation) {
      this.#pendingNavigation = undefined;
    }
    const ready = this.#ready || (answer.kind === 'replace' && installed !== undefined);
    const changed = this.#tail !== tail || this.#window !== window || ready !== this.#ready;
    this.#ready = ready;
    if (changed) this.#commit();
    for (const notify of this.#durableWaiters) notify();
    return changed;
  }

  /** The next window value, or `undefined` where this answer reaches no edge of it. */
  #install(answer: TranscriptAssembly): TranscriptWindow | undefined {
    const window = this.#window;
    if (answer.kind === 'replace') {
      if (answer.navigation !== undefined && answer.navigation !== this.#pendingNavigation) {
        return undefined;
      }
      return sameWindow(window, makeWindow(
        answer.rows,
        answer.hasOlder ?? false,
        answer.durableThrough,
        answer.hasNewer ?? false,
      ));
    }
    if (answer.kind === 'extend') {
      const extension = answer.extension!;
      if (extension.direction === 'older') {
        if (extension.anchor !== (window.order[0] ?? null)) return undefined;
        return sameWindow(window, makeWindow(
          mergeRows(window, answer.rows),
          answer.hasOlder ?? window.hasOlder,
          window.through,
          window.hasNewerAtThrough,
        ));
      }
      if (extension.anchor !== (window.order.at(-1) ?? null)) return undefined;
      // A page read before the tail grew cannot close the newer edge: rows that
      // landed meanwhile are not in it, so the edge stays open.
      const regressed = answer.durableThrough !== null && window.through !== null &&
        answer.durableThrough < window.through;
      return sameWindow(window, makeWindow(
        mergeRows(window, answer.rows),
        window.hasOlder,
        answer.durableThrough ?? window.through,
        (answer.hasNewer ?? false) || regressed,
      ));
    }
    if (!this.#joinsTail(answer.coversFrom)) return undefined;
    return sameWindow(window, makeWindow(
      mergeRows(window, answer.rows),
      window.hasOlder,
      answer.durableThrough ?? window.through,
      false,
    ));
  }

  /** Whether a read that started at `coversFrom` continues this window's newer edge. */
  #joinsTail(coversFrom: number | null | undefined): boolean {
    return coversFrom !== undefined &&
      coversFrom === this.#window.through &&
      !this.#window.hasNewerAtThrough;
  }

  /** Fires after every committed change to `snapshot()`. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /**
   * Drops durable rows outside `[oldestSequence, newestSequence]`. Either edge
   * that lost rows becomes a history edge again. An extension already in flight
   * carries the anchor it was read from, so a trim needs no announcement: the
   * anchor no longer matches an edge, and the answer is refused on arrival.
   */
  retain(oldestSequence: number | null, newestSequence: number | null): boolean {
    const window = this.#window;
    let droppedOlder = false;
    let droppedNewer = false;
    const kept = window.order.filter((sequence) => {
      const older = oldestSequence !== null && sequence < oldestSequence;
      const newer = newestSequence !== null && sequence > newestSequence;
      droppedOlder ||= older;
      droppedNewer ||= newer;
      return !older && !newer;
    });
    if (!droppedOlder && !droppedNewer) return false;
    this.#window = makeWindow(
      new Map(kept.map((sequence) => [sequence, window.rows.get(sequence)!])),
      window.hasOlder || droppedOlder,
      droppedNewer ? kept.at(-1) ?? null : window.through,
      window.hasNewerAtThrough || droppedNewer,
    );
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
    const window = this.#window;
    return window.order.map((sequence) => ({
      sequence,
      message: structuredClone(window.rows.get(sequence)!.message),
    }));
  }

  range(): DesktopTranscriptRangeState {
    if (!this.#sourceSessionId || !this.#generation || !this.#hostEpoch) {
      throw new Error('Desktop transcript range is not initialized');
    }
    const window = this.#window;
    return {
      sessionId: this.sessionId,
      generation: this.#generation,
      hostEpoch: this.#hostEpoch,
      durableThrough: this.#tail.through,
      oldestSequence: window.order[0] ?? null,
      newestSequence: window.order.at(-1) ?? null,
      hasOlder: window.hasOlder,
      hasNewer: this.#hasNewer(),
      ready: this.#ready,
    };
  }

  /** The window has newer history whenever anything durable lies beyond it. */
  #hasNewer(): boolean {
    const window = this.#window;
    return window.hasNewerAtThrough ||
      (this.#tail.through !== null &&
        (window.through === null || this.#tail.through > window.through));
  }

  hasDurableMessage(messageId: string): boolean {
    for (const record of this.#window.rows.values()) {
      if (record.message.id === messageId) return true;
    }
    return false;
  }

  newestDurableUserSequence(): number | null {
    return this.#window.newestUserSequence;
  }

  sequenceForTurn(turnId: string, edge: 'first' | 'last' = 'first'): number | null {
    const window = this.#window;
    const order = edge === 'first' ? window.order : [...window.order].reverse();
    return order.find((sequence) => window.rows.get(sequence)?.message.turnId === turnId) ?? null;
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

  #acceptFragment(
    assembly: TranscriptAssembly,
    fragment: DesktopTranscriptFragment,
    collects: boolean,
  ): void {
    const key = `${fragment.source}:${typeof fragment.identity}:${fragment.identity}`;
    let pending = assembly.fragments.get(key);
    if (!pending) {
      pending = {
        source: fragment.source,
        identity: fragment.identity,
        order: fragment.order,
        totalBytes: fragment.totalBytes,
        bytes: new Uint8Array(fragment.totalBytes),
        receivedBytes: 0,
      };
      assembly.fragments.set(key, pending);
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
    if (pending.receivedBytes < pending.totalBytes) return;
    assembly.fragments.delete(key);
    if (!collects) return;
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
      assembly.rows.set(pending.identity as number, { message, encoded: projected });
      return;
    }
    if (typeof pending.identity !== 'string' || message.id !== pending.identity) {
      throw new Error('Desktop transcript overlay identity changed');
    }
    if (pending.order === null || !Number.isSafeInteger(pending.order) || pending.order < 0) {
      throw new Error('Invalid Desktop transcript overlay order');
    }
    assembly.overlay.set(pending.identity, { message, encoded: projected, order: pending.order });
  }

  #createSnapshot(): DesktopTranscriptRangeSnapshot {
    const window = this.#window;
    const tail = this.#tail;
    const messages = Object.freeze([
      ...window.order.map((sequence) => window.rows.get(sequence)!.message),
      // The overlay is a fact about the tail, so it belongs to the view only
      // while the window is at the tail.
      ...(this.#hasNewer()
        ? []
        : tail.overlayOrder.map((messageId) => tail.overlay.get(messageId)!.message)),
    ]);
    return Object.freeze({
      ...this.range(),
      messages,
    });
  }
}

function continuesAssembly(
  assembly: TranscriptAssembly,
  batch: DesktopTranscriptBatchPayload,
): boolean {
  return assembly.sessionId === batch.sessionId &&
    assembly.generation === batch.generation &&
    assembly.hostEpoch === batch.hostEpoch &&
    assembly.navigation === batch.navigation &&
    assembly.extension?.direction === batch.extends?.direction &&
    assembly.extension?.anchor === batch.extends?.anchor;
}

function mergeRows(
  window: TranscriptWindow,
  rows: ReadonlyMap<number, StoredRecord>,
): Map<number, StoredRecord> {
  const merged = new Map(window.rows);
  for (const [sequence, record] of rows) {
    const existing = merged.get(sequence);
    if (existing && existing.encoded !== record.encoded) {
      throw new Error('Desktop transcript durable record changed');
    }
    merged.set(sequence, record);
  }
  return merged;
}

function makeWindow(
  rows: ReadonlyMap<number, StoredRecord>,
  hasOlder: boolean,
  through: number | null,
  hasNewerAtThrough: boolean,
): TranscriptWindow {
  const order = [...rows.keys()].sort((left, right) => left - right);
  let newestUserSequence: number | null = null;
  for (const sequence of order) {
    if (rows.get(sequence)!.message.type === 'user') newestUserSequence = sequence;
  }
  return { rows, order, hasOlder, through, hasNewerAtThrough, newestUserSequence };
}

/** Keeps the current value where the candidate says the same thing, so that a
 *  fresh snapshot object always means a window that actually moved. */
function sameWindow(current: TranscriptWindow, candidate: TranscriptWindow): TranscriptWindow {
  if (
    current.hasOlder !== candidate.hasOlder ||
    current.through !== candidate.through ||
    current.hasNewerAtThrough !== candidate.hasNewerAtThrough ||
    current.order.length !== candidate.order.length
  ) return candidate;
  for (const [index, sequence] of current.order.entries()) {
    if (candidate.order[index] !== sequence) return candidate;
    if (current.rows.get(sequence)!.encoded !== candidate.rows.get(sequence)!.encoded) {
      return candidate;
    }
  }
  return current;
}

function orderOverlay(overlay: ReadonlyMap<string, OverlayRecord>): string[] {
  return [...overlay.keys()].sort((left, right) => {
    const order = overlay.get(left)!.order - overlay.get(right)!.order;
    return order === 0 ? left.localeCompare(right) : order;
  });
}

function freezeTranscriptValue<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeTranscriptValue(child);
  return Object.freeze(value);
}
