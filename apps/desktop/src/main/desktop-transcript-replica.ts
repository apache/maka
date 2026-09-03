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

import { randomUUID } from 'node:crypto';
import type { StoredMessage } from '@maka/core/session';
import {
  createRuntimeHostSessionProjectionSeed,
  type RuntimeHostSessionProjectionSeed,
} from '@maka/runtime-host/adapter';
import { RuntimeHostSubscriptionError } from '@maka/runtime-host/client';
import {
  SESSION_TRANSCRIPT_RANGE_MAX_BYTES,
  type SessionTranscriptPage,
} from '@maka/runtime-host/protocol';
import {
  DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS,
  DESKTOP_TRANSCRIPT_OVERLAY_CACHE_MAX_BYTES,
  DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES,
} from '../preload/transcript-contract.js';
import type { DesktopRuntimeHostSession } from './runtime-host-client.js';

export interface DesktopTranscriptReplicaOptions {
  readonly generation?: string;
  readonly maxMessageBytes?: number;
  readonly maxResidentBytes?: number;
  readonly maxResidentTurns?: number;
  readonly maxOverlayBytes?: number;
  readonly accountPreparationBytes?: (deltaBytes: number) => void;
  readonly onChange?: (
    replica: DesktopTranscriptReplica,
    change: DesktopTranscriptReplicaChange,
  ) => void;
}

export interface DesktopSequencedTranscriptMessage {
  readonly sequence: number;
  readonly message: StoredMessage;
}

export interface DesktopTranscriptReplicaSnapshot {
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly durableThrough: number | null;
  readonly durable: readonly DesktopSequencedTranscriptMessage[];
  readonly overlay: readonly StoredMessage[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

export interface DesktopTranscriptReplicaChange {
  readonly durableThrough: number | null;
  readonly durableUpserts: readonly DesktopSequencedTranscriptMessage[];
  readonly evictedDurableSequences: readonly number[];
  readonly completedOverlayMessageIds: readonly string[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
}

interface ResidentMessage extends DesktopSequencedTranscriptMessage {
  readonly encodedBytes: number;
}

export class DesktopTranscriptReplica {
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly #handle: DesktopRuntimeHostSession;
  readonly #durableCoverage: DesktopRuntimeHostSession['transcriptBootstrap']['durableCoverage'];
  readonly #maxResidentBytes: number;
  readonly #maxResidentTurns: number;
  readonly #maxOverlayBytes: number;
  readonly #maxMessageBytes: number;
  readonly #accountPreparationBytes: (deltaBytes: number) => void;
  readonly #onChange: (
    replica: DesktopTranscriptReplica,
    change: DesktopTranscriptReplicaChange,
  ) => void;
  readonly #durable = new Map<number, ResidentMessage>();
  readonly #overlay = new Map<string, StoredMessage>();
  #residentBytes = 0;
  #overlayBytes = 0;
  #durableThrough: number | null;
  #targetThrough: number | null;
  #hasOlder: boolean;
  #hasNewer = false;
  #resident = true;
  #residentExternallyAccounted = true;
  #closed = false;
  #catchUpTask: Promise<void> | undefined;
  #operationTail = Promise.resolve();

  private constructor(
    handle: DesktopRuntimeHostSession,
    options: DesktopTranscriptReplicaOptions,
  ) {
    this.#handle = handle;
    this.#durableCoverage = handle.transcriptBootstrap.durableCoverage;
    this.sessionId = handle.snapshot.session.sessionId;
    this.generation = options.generation ?? randomUUID();
    this.hostEpoch = handle.hostEpoch;
    this.#maxResidentBytes =
      options.maxResidentBytes ?? DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES;
    this.#maxResidentTurns =
      options.maxResidentTurns ?? DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS;
    this.#maxOverlayBytes =
      options.maxOverlayBytes ?? DESKTOP_TRANSCRIPT_OVERLAY_CACHE_MAX_BYTES;
    this.#maxMessageBytes = options.maxMessageBytes ?? SESSION_TRANSCRIPT_RANGE_MAX_BYTES;
    this.#accountPreparationBytes = options.accountPreparationBytes ?? (() => undefined);
    this.#onChange = options.onChange ?? (() => undefined);
    this.#durableThrough = handle.transcriptBootstrap.throughSequence;
    this.#targetThrough = this.#durableThrough;
    this.#hasOlder = handle.transcriptBootstrap.durable.nextCursor !== null;
  }

  static async prepare(
    handle: DesktopRuntimeHostSession,
    options: DesktopTranscriptReplicaOptions = {},
  ): Promise<DesktopTranscriptReplica> {
    const replica = new DesktopTranscriptReplica(handle, options);
    try {
      await replica.#withAssembly(async (accountAssemblyBytes) => {
        replica.#installOverlay(
          await handle.loadTranscriptOverlay(replica.#maxMessageBytes, accountAssemblyBytes),
        );
      });
      await replica.#withDecodedPage(handle.transcriptBootstrap.durable, (durable) => {
        replica.#installDurable(durable.messages);
        replica.#hasOlder = durable.nextCursor !== null;
      });
      replica.#evictToBudget(
        undefined,
        'oldest',
        handle.transcriptBootstrap.durable.protectedTurnSequence ??
          replica.#durableThrough ??
          undefined,
      );
      if (replica.#overlayBytes > replica.#maxOverlayBytes) {
        throw new RangeError('Desktop transcript overlay exceeds the session cache limit');
      }
      return replica;
    } catch (error) {
      replica.close();
      throw error;
    }
  }

  get residentBytes(): number {
    return this.#residentBytes;
  }

  get resident(): boolean {
    return this.#resident;
  }

  adoptResidentAccounting(): void {
    if (!this.#residentExternallyAccounted) return;
    this.#residentExternallyAccounted = false;
    this.#accountPreparationBytes(-this.#residentBytes);
  }

  get durableThrough(): number | null {
    return this.#durableThrough;
  }

  get projectionSeed(): RuntimeHostSessionProjectionSeed {
    this.#assertResident();
    return createRuntimeHostSessionProjectionSeed(this.messages(), this.#handle.snapshot);
  }

  snapshot(): DesktopTranscriptReplicaSnapshot {
    this.#assertOpen();
    this.#assertResident();
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      hostEpoch: this.hostEpoch,
      durableThrough: this.#durableThrough,
      durable: this.#orderedDurable(false),
      overlay: [...this.#overlay.values()],
      hasOlder: this.#hasOlder,
      hasNewer: this.#hasNewer,
    };
  }

  messages(): StoredMessage[] {
    this.#assertOpen();
    this.#assertResident();
    return this.#orderedDurable()
      .map((entry) => entry.message)
      .concat([...this.#overlay.values()].map((message) => structuredClone(message)));
  }

  messagesForTurn(turnId: string): StoredMessage[] {
    return this.messages().filter((message) => message.turnId === turnId);
  }

  latestDurableVisibleMessageId(): string | null {
    this.#assertOpen();
    this.#assertResident();
    let latest: ResidentMessage | undefined;
    for (const entry of this.#durable.values()) {
      if (
        (entry.message.type === 'user' || entry.message.type === 'assistant') &&
        (!latest || entry.sequence > latest.sequence)
      ) {
        latest = entry;
      }
    }
    return latest?.message.id ?? null;
  }

  async loadBefore(
    anchorSequence: number | null,
    maxBytes: number,
  ): Promise<void> {
    return this.#enqueue(() => this.#loadBefore(anchorSequence, maxBytes));
  }

  async #loadBefore(anchorSequence: number | null, maxBytes: number): Promise<void> {
    this.#assertOpen();
    const throughSequence = this.#durableThrough;
    if (throughSequence === null) return;
    const anchor = anchorSequence ?? this.#oldestSequence();
    const page = await this.#handle.loadTranscriptPage({
      source: 'durable',
      direction: 'older',
      throughSequence,
      cursor: null,
      anchorSequence: anchor,
      maxBytes,
    });
    await this.#withDecodedPage(page, (decoded) => {
      this.#assertOpen();
      // Same post-await `#resident` invariant as `#replaceWithRange` and the
      // paged catch-up: a concurrent `discard()` may have reclaimed this
      // replica while the older page was in flight. Installing the page here
      // would repopulate durable state and undo the eviction.
      if (!this.#resident) return;
      this.#acceptRange(decoded.messages);
      if (
        anchor !== null &&
        decoded.messages.length > 0 &&
        !this.#matchesCoverageStep(anchor, decoded.messages.at(-1)!.identity + 1)
      ) {
        throw correlationError('Desktop transcript older page did not meet its anchor');
      }
      const completedOverlayMessageIds = this.#installDurable(decoded.messages);
      this.#hasOlder = decoded.nextCursor !== null;
      const evictedDurableSequences = this.#evictToBudget(
        undefined,
        'newest',
        anchor ?? undefined,
      );
      this.#publish(decoded.messages, completedOverlayMessageIds, evictedDurableSequences);
    });
  }

  async loadAround(sequence: number, maxBytes: number): Promise<void> {
    return this.#enqueue(() => this.#loadAround(sequence, maxBytes));
  }

  async #loadAround(sequence: number, maxBytes: number): Promise<void> {
    this.#assertOpen();
    const throughSequence = this.#durableThrough;
    if (throughSequence === null || sequence > throughSequence) return;
    await this.#replaceWithRange(throughSequence, sequence, maxBytes);
  }

  async #replaceWithRange(
    throughSequence: number,
    sequence: number,
    maxBytes: number,
  ): Promise<void> {
    const loadTail = sequence === throughSequence;
    const page = await this.#handle.loadTranscriptPage({
      source: 'durable',
      direction: loadTail ? 'older' : 'newer',
      throughSequence,
      cursor: null,
      anchorSequence: loadTail ? sequence + 1 : sequence === 0 ? null : sequence - 1,
      maxBytes,
    });
    await this.#withDecodedPage(page, (decoded) => {
      this.#assertOpen();
      // `#resident` can flip to false across the `await` above (a concurrent
      // `discard()` reclaims memory for a non-visible session while the page is
      // in flight). Re-anchoring here would repopulate durable state and undo
      // the eviction, resurrecting a deliberately discarded replica past its
      // memory budget. The paged catch-up guards its own post-await callback
      // the same way; mirror it before mutating or publishing.
      if (!this.#resident) return;
      this.#acceptRange(decoded.messages);
      if (
        decoded.messages.length > 0 &&
        (loadTail
          ? !this.#matchesCoverageStep(sequence, decoded.messages.at(-1)!.identity)
          : decoded.messages[0]!.identity !== sequence)
      ) {
        throw correlationError('Desktop transcript range did not meet its anchor');
      }
      const evictedDurableSequences = [...this.#durable.keys()];
      this.#clearDurable();
      const completedOverlayMessageIds = this.#installDurable(decoded.messages);
      this.#durableThrough = throughSequence;
      this.#hasOlder = loadTail ? decoded.nextCursor !== null : sequence > 0;
      this.#hasNewer = loadTail ? false : decoded.nextCursor !== null;
      evictedDurableSequences.push(
        ...this.#evictToBudget(
          undefined,
          loadTail ? 'oldest' : 'newest',
          loadTail ? (page.protectedTurnSequence ?? sequence) : sequence,
        ),
      );
      this.#publish(decoded.messages, completedOverlayMessageIds, evictedDurableSequences);
    });
  }

  advance(throughSequence: number): Promise<void> {
    this.#assertOpen();
    if (this.#targetThrough === null || throughSequence > this.#targetThrough) {
      this.#targetThrough = throughSequence;
    }
    if (!this.#resident) {
      this.#durableThrough = this.#targetThrough;
      return Promise.resolve();
    }
    this.#catchUpTask ??= this.#enqueue(() => this.#catchUp()).finally(() => {
      this.#catchUpTask = undefined;
      if (
        !this.#closed &&
        this.#targetThrough !== null &&
        (this.#durableThrough === null || this.#targetThrough > this.#durableThrough)
      ) {
        void this.advance(this.#targetThrough).catch(() => undefined);
      }
    });
    return this.#catchUpTask;
  }

  trimDurable(targetResidentBytes: number): DesktopTranscriptReplicaChange | undefined {
    this.#assertOpen();
    if (!this.#resident) return undefined;
    const evictedDurableSequences = this.#evictToBudget(targetResidentBytes);
    return evictedDurableSequences.length === 0
      ? undefined
      : this.#change([], [], evictedDurableSequences);
  }

  discard(): void {
    this.#assertOpen();
    if (!this.#resident) return;
    this.#resident = false;
    this.#clearDurable();
    for (const message of this.#overlay.values()) {
      this.#adjustOverlayBytes(-encodedMessageBytes(message));
    }
    this.#overlay.clear();
    this.#overlayBytes = 0;
  }

  close(): void {
    this.#closed = true;
    this.#resident = false;
    this.#durable.clear();
    this.#overlay.clear();
    this.#overlayBytes = 0;
    if (this.#residentExternallyAccounted) {
      this.#accountPreparationBytes(-this.#residentBytes);
    }
    this.#residentBytes = 0;
  }

  async #catchUp(): Promise<void> {
    while (!this.#closed && this.#resident) {
      const target = this.#targetThrough;
      if (target === null || (this.#durableThrough !== null && target <= this.#durableThrough)) {
        return;
      }
      if (this.#hasNewer) {
        // The resident window was trimmed off the tail (e.g. after loading
        // older history, `#evictToBudget(..., 'newest')` set `#hasNewer`), so
        // `target` cannot be appended contiguously to what is resident. Bumping
        // the watermark and publishing an empty change here silently dropped
        // the freshly persisted message: an already-open consumer never learned
        // about it and only a fresh subscription (the user switching sessions
        // and back) re-read it. Re-anchor to the newest window instead — the
        // same recovery a fresh subscription performs — so the append reaches
        // open consumers live.
        await this.#replaceWithRange(target, target, 512 * 1024);
        return;
      }
      let cursor: string | null = null;
      const anchorSequence = this.#durableThrough;
      let nextSequence = (anchorSequence ?? -1) + 1;
      do {
        if (!this.#resident) return;
        const page: SessionTranscriptPage = await this.#handle.loadTranscriptPage({
          source: 'durable',
          direction: 'newer',
          throughSequence: target,
          cursor,
          anchorSequence: cursor === null ? anchorSequence : null,
          maxBytes: 512 * 1024,
        });
        await this.#withDecodedPage(page, (decoded) => {
          this.#assertOpen();
          if (!this.#resident) return;
          if (decoded.messages.length === 0 && decoded.nextCursor !== null) {
            throw correlationError('Desktop transcript catch-up returned an empty continuation');
          }
          this.#acceptRange(decoded.messages);
          if (
            decoded.messages.length > 0 &&
            !this.#matchesCoverageStep(decoded.messages[0]!.identity, nextSequence)
          ) {
            throw correlationError('Desktop transcript catch-up has a sequence gap');
          }
          if (decoded.messages.length > 0) {
            nextSequence = decoded.messages.at(-1)!.identity + 1;
          }
          const completedOverlayMessageIds = this.#installDurable(decoded.messages);
          const evictedDurableSequences = this.#evictToBudget(
            undefined,
            'oldest',
            page.protectedTurnSequence ?? decoded.messages.at(-1)?.identity,
          );
          this.#publish(decoded.messages, completedOverlayMessageIds, evictedDurableSequences);
          cursor = decoded.nextCursor;
        });
      } while (cursor !== null);
      // A concurrent `discard()` (LRU reclaim for another observed session) can
      // flip `#resident` to false across any page `await` above. The per-page
      // callback already returns early in that case, so `nextSequence` is
      // left short of the watermark. Without this guard the check below would
      // turn a benign memory reclaim into a fatal `correlation_changed` that
      // drives the session terminal. A discarded replica has no watermark to
      // meet, so return cleanly and let a later resume re-catch-up.
      if (!this.#resident) return;
      if (this.#durableCoverage === 'complete' && nextSequence !== target + 1) {
        throw correlationError('Desktop transcript catch-up ended before its watermark');
      }
      this.#durableThrough = target;
      this.#publish([], [], []);
    }
  }

  #installOverlay(messages: readonly StoredMessage[]): void {
    for (const message of messages) {
      const previous = this.#overlay.get(message.id);
      if (previous) this.#adjustOverlayBytes(-encodedMessageBytes(previous));
      this.#overlay.set(message.id, message);
      this.#adjustOverlayBytes(encodedMessageBytes(message));
    }
  }

  #installDurable(
    messages: readonly {
      readonly identity: number;
      readonly message: StoredMessage;
    }[],
  ): string[] {
    const completedOverlayMessageIds: string[] = [];
    for (const item of messages) {
      const previous = this.#durable.get(item.identity);
      if (previous && previous.message.id !== item.message.id) {
        throw correlationError(`Desktop transcript sequence ${item.identity} changed identity`);
      }
      if (previous) this.#adjustResidentBytes(-previous.encodedBytes);
      const message = item.message;
      const encodedBytes = encodedMessageBytes(message);
      this.#durable.set(item.identity, {
        sequence: item.identity,
        message,
        encodedBytes,
      });
      this.#adjustResidentBytes(encodedBytes);
      const overlay = this.#overlay.get(message.id);
      if (overlay) {
        this.#overlay.delete(message.id);
        this.#adjustOverlayBytes(-encodedMessageBytes(overlay));
        completedOverlayMessageIds.push(message.id);
      }
    }
    return completedOverlayMessageIds;
  }

  #acceptRange(
    messages: readonly { readonly identity: number }[],
  ): void {
    for (let index = 1; index < messages.length; index += 1) {
      const previous = messages[index - 1]!.identity;
      const current = messages[index]!.identity;
      if (!this.#matchesCoverageStep(current, previous + 1)) {
        throw correlationError('Desktop transcript page has a sequence gap');
      }
    }
  }

  #matchesCoverageStep(sequence: number, firstPossibleSequence: number): boolean {
    return this.#durableCoverage === 'complete'
      ? sequence === firstPossibleSequence
      : sequence >= firstPossibleSequence;
  }

  #publish(
    messages: readonly {
      readonly identity: number;
      readonly message: StoredMessage;
    }[],
    completedOverlayMessageIds: readonly string[],
    evictedDurableSequences: readonly number[],
  ): void {
    this.#onChange(this, this.#change(messages, completedOverlayMessageIds, evictedDurableSequences));
  }

  #change(
    messages: readonly {
      readonly identity: number;
      readonly message: StoredMessage;
    }[],
    completedOverlayMessageIds: readonly string[],
    evictedDurableSequences: readonly number[],
  ): DesktopTranscriptReplicaChange {
    return {
      durableThrough: this.#durableThrough,
      durableUpserts: messages.flatMap((entry) => {
        const resident = this.#durable.get(entry.identity);
        return resident?.message.id === entry.message.id
          ? [{ sequence: entry.identity, message: resident.message }]
          : [];
      }),
      evictedDurableSequences: [...new Set(evictedDurableSequences)].filter(
        (sequence) => !this.#durable.has(sequence),
      ),
      completedOverlayMessageIds,
      hasOlder: this.#hasOlder,
      hasNewer: this.#hasNewer,
    };
  }

  #evictToBudget(
    budget: number | undefined = undefined,
    edge: 'oldest' | 'newest' = 'oldest',
    protectedSequence?: number,
  ): number[] {
    const residentBudget = budget ?? this.#maxResidentBytes + this.#overlayBytes;
    const evicted: number[] = [];
    const sequences = [...this.#durable.keys()].sort((left, right) => left - right);
    const turnGroups = new Map<string, number[]>();
    for (const sequence of sequences) {
      const entry = this.#durable.get(sequence);
      if (!entry) continue;
      const turnKey = residentTurnKey(entry);
      const group = turnGroups.get(turnKey);
      if (group) group.push(sequence);
      else turnGroups.set(turnKey, [sequence]);
    }
    const orderedTurns = [...turnGroups.entries()];
    let oldestIndex = 0;
    let newestIndex = orderedTurns.length - 1;
    let residentTurns = orderedTurns.length;
    const protectedEntry = protectedSequence === undefined
      ? undefined
      : this.#durable.get(protectedSequence);
    const protectedTurnKey = protectedEntry === undefined
      ? undefined
      : residentTurnKey(protectedEntry);
    const protectedIndex = protectedTurnKey === undefined
      ? -1
      : orderedTurns.findIndex(([turnKey]) => turnKey === protectedTurnKey);
    const take = (
      candidateEdge: 'oldest' | 'newest',
    ): readonly [string, number[]] | undefined => {
      const index = candidateEdge === 'oldest' ? oldestIndex : newestIndex;
      if (oldestIndex > newestIndex) return undefined;
      const turn = orderedTurns[index];
      if (!turn || turn[0] === protectedTurnKey) return undefined;
      if (candidateEdge === 'oldest') oldestIndex += 1;
      else newestIndex -= 1;
      return turn;
    };
    while (
      this.#residentBytes > residentBudget
      || residentTurns > this.#maxResidentTurns
    ) {
      let evictionEdge = protectedIndex < 0
        ? edge
        : protectedIndex - oldestIndex > newestIndex - protectedIndex
          ? 'oldest'
          : protectedIndex - oldestIndex < newestIndex - protectedIndex
            ? 'newest'
            : edge;
      let turn = take(evictionEdge);
      if (turn === undefined) {
        evictionEdge = edge === 'oldest' ? 'newest' : 'oldest';
        turn = take(evictionEdge);
      }
      if (turn === undefined) break;
      for (const sequence of turn[1]) {
        const entry = this.#durable.get(sequence);
        if (!entry) continue;
        this.#durable.delete(sequence);
        this.#adjustResidentBytes(-entry.encodedBytes);
        evicted.push(sequence);
      }
      residentTurns -= 1;
      if (evictionEdge === 'oldest') this.#hasOlder = true;
      else this.#hasNewer = true;
    }
    return evicted;
  }

  #orderedDurable(cloneMessages = true): DesktopSequencedTranscriptMessage[] {
    return [...this.#durable.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => ({
        sequence: entry.sequence,
        message: cloneMessages ? structuredClone(entry.message) : entry.message,
      }));
  }

  #oldestSequence(): number | null {
    let oldest: number | null = null;
    for (const sequence of this.#durable.keys()) {
      if (oldest === null || sequence < oldest) oldest = sequence;
    }
    return oldest;
  }

  #clearDurable(): void {
    for (const entry of this.#durable.values()) this.#adjustResidentBytes(-entry.encodedBytes);
    this.#durable.clear();
  }

  #adjustResidentBytes(deltaBytes: number): void {
    if (this.#residentExternallyAccounted) this.#accountPreparationBytes(deltaBytes);
    this.#residentBytes += deltaBytes;
  }

  #adjustOverlayBytes(deltaBytes: number): void {
    this.#adjustResidentBytes(deltaBytes);
    this.#overlayBytes += deltaBytes;
  }

  async #withDecodedPage<T>(
    page: SessionTranscriptPage,
    accept: (
      decoded: Awaited<ReturnType<DesktopRuntimeHostSession['decodeTranscriptPage']>>,
    ) => T | Promise<T>,
  ): Promise<T> {
    return this.#withAssembly(async (accountAssemblyBytes) =>
      accept(
        await this.#handle.decodeTranscriptPage(
          page,
          this.#maxMessageBytes,
          accountAssemblyBytes,
        ),
      ),
    );
  }

  async #withAssembly<T>(
    operation: (accountAssemblyBytes: (deltaBytes: number) => void) => Promise<T>,
  ): Promise<T> {
    let acquiredBytes = 0;
    let balance = 0;
    const accountAssemblyBytes = (deltaBytes: number) => {
      const next = balance + deltaBytes;
      if (!Number.isSafeInteger(next) || next < 0) {
        throw new RangeError('Invalid Desktop transcript assembly accounting');
      }
      balance = next;
      if (deltaBytes <= 0) return;
      this.#accountPreparationBytes(deltaBytes);
      acquiredBytes += deltaBytes;
    };
    try {
      return await operation(accountAssemblyBytes);
    } finally {
      if (acquiredBytes > 0) this.#accountPreparationBytes(-acquiredBytes);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Desktop transcript replica is closed');
  }

  #assertResident(): void {
    if (!this.#resident) {
      throw new Error('Desktop transcript replica was evicted');
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.#operationTail.then(operation);
    this.#operationTail = task.catch(() => undefined);
    return task;
  }
}

function encodedMessageBytes(message: StoredMessage): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

function residentTurnKey(entry: ResidentMessage): string {
  const turnId = messageTurnId(entry.message);
  return turnId === undefined ? `sequence:${entry.sequence}` : `turn:${turnId}`;
}

function messageTurnId(message: StoredMessage): string | undefined {
  const turnId = 'turnId' in message ? message.turnId : undefined;
  return typeof turnId === 'string' ? turnId : undefined;
}

function correlationError(message: string): RuntimeHostSubscriptionError {
  return new RuntimeHostSubscriptionError('correlation_changed', message);
}
