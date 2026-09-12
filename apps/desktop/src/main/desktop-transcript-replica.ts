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
  DESKTOP_TRANSCRIPT_OVERLAY_CACHE_MAX_BYTES,
  DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_MAX_TURNS,
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

/** A durable page read on behalf of one Renderer window; never installed here. */
export interface DesktopTranscriptReplicaPage {
  readonly durableThrough: number;
  readonly durable: readonly DesktopSequencedTranscriptMessage[];
  readonly hasOlder?: boolean;
  readonly hasNewer?: boolean;
}

/**
 * Tail-cache growth broadcast to every consumer. `coversFrom` is the watermark
 * the read that produced these rows started at; `null` means the read started
 * at the beginning of the transcript.
 */
export interface DesktopTranscriptReplicaChange {
  readonly coversFrom: number | null;
  readonly durableThrough: number | null;
  readonly durableUpserts: readonly DesktopSequencedTranscriptMessage[];
}

interface ResidentMessage extends DesktopSequencedTranscriptMessage {
  readonly encodedBytes: number;
}

/**
 * Main's view of one Session transcript: the durable tail the projector needs,
 * the overlay of not-yet-durable messages, and a pass-through pager for the
 * Renderer's own window. The Renderer decides what it holds; this class only
 * keeps the tail current and answers page reads.
 */
export class DesktopTranscriptReplica {
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly #handle: DesktopRuntimeHostSession;
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
    this.sessionId = handle.snapshot.session.sessionId;
    this.generation = options.generation ?? randomUUID();
    this.hostEpoch = handle.hostEpoch;
    this.#maxResidentBytes =
      options.maxResidentBytes ?? DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES;
    this.#maxResidentTurns =
      options.maxResidentTurns ?? DESKTOP_TRANSCRIPT_TAIL_MAX_TURNS;
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
      hasNewer: false,
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

  loadBefore(
    anchorSequence: number | null,
    maxBytes: number,
    isCurrent: () => boolean = () => true,
  ): Promise<DesktopTranscriptReplicaPage | undefined> {
    return this.#enqueue(() => this.#loadPage('older', anchorSequence, maxBytes, isCurrent));
  }

  loadAfter(
    anchorSequence: number | null,
    maxBytes: number,
    isCurrent: () => boolean = () => true,
  ): Promise<DesktopTranscriptReplicaPage | undefined> {
    return this.#enqueue(() => this.#loadPage('newer', anchorSequence, maxBytes, isCurrent));
  }

  async #loadPage(
    direction: 'older' | 'newer',
    anchorSequence: number | null,
    maxBytes: number,
    isCurrent: () => boolean,
  ): Promise<DesktopTranscriptReplicaPage | undefined> {
    if (!this.#isLive() || !isCurrent()) return undefined;
    const throughSequence = this.#durableThrough;
    if (throughSequence === null) return undefined;
    const page = await this.#handle.loadTranscriptPage({
      source: 'durable',
      direction,
      throughSequence,
      cursor: null,
      anchorSequence,
      maxBytes,
    });
    return this.#withDecodedPage(page, (decoded) => {
      if (!this.#isLive() || !isCurrent()) return undefined;
      this.#acceptRange(decoded.messages);
      if (
        anchorSequence !== null &&
        decoded.messages.length > 0 &&
        !(direction === 'older'
          ? this.#matchesCoverageStep(anchorSequence, decoded.messages.at(-1)!.identity + 1)
          : this.#matchesCoverageStep(decoded.messages[0]!.identity, anchorSequence + 1))
      ) {
        throw correlationError(`Desktop transcript ${direction} page did not meet its anchor`);
      }
      this.#completeOverlay(decoded.messages);
      return {
        durableThrough: throughSequence,
        durable: decoded.messages.map((entry) => ({
          sequence: entry.identity,
          message: entry.message,
        })),
        ...(direction === 'older'
          ? { hasOlder: decoded.nextCursor !== null }
          : { hasNewer: decoded.nextCursor !== null }),
      };
    });
  }

  /**
   * Reads the newest page back into the tail cache when global reclaim has
   * trimmed it below a tail. Follow-tail is answered from this cache, so
   * without the refill a reader returning to latest is shown whatever reclaim
   * happened to leave — down to nothing.
   */
  refillTail(maxBytes: number, isCurrent: () => boolean = () => true): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#isLive() || !isCurrent() || !this.#tailIsShort()) return;
      const throughSequence = this.#durableThrough;
      if (throughSequence === null) return;
      const page = await this.#handle.loadTranscriptPage({
        source: 'durable',
        direction: 'older',
        throughSequence,
        cursor: null,
        anchorSequence: throughSequence + 1,
        maxBytes,
      });
      await this.#withDecodedPage(page, (decoded) => {
        if (!this.#isLive() || !isCurrent()) return;
        this.#acceptRange(decoded.messages);
        this.#installDurable(decoded.messages);
        this.#hasOlder = decoded.nextCursor !== null;
        this.#evictToBudget(
          undefined,
          page.protectedTurnSequence ?? decoded.messages.at(-1)?.identity,
        );
      });
    });
  }

  /**
   * Whether the cache holds less than the tail it is meant to hold. `#hasOlder`
   * settles the case a Turn count cannot: a short Session whose whole durable
   * transcript is resident is never short, however few Turns that is.
   */
  #tailIsShort(): boolean {
    if (!this.#hasOlder) return false;
    const turns = new Set<string>();
    for (const entry of this.#durable.values()) turns.add(residentTurnKey(entry));
    return turns.size < this.#maxResidentTurns;
  }

  loadAround(
    sequence: number,
    maxBytes: number,
    isCurrent: () => boolean = () => true,
  ): Promise<DesktopTranscriptReplicaSnapshot | undefined> {
    return this.#enqueue(async () => {
      if (!this.#isLive() || !isCurrent()) return undefined;
      const throughSequence = this.#durableThrough;
      if (throughSequence === null || sequence > throughSequence) return undefined;
      const page = await this.#handle.loadTranscriptPage({
        source: 'durable',
        direction: 'newer',
        throughSequence,
        cursor: null,
        anchorSequence: sequence === 0 ? null : sequence - 1,
        maxBytes,
      });
      if (!this.#isLive() || !isCurrent()) return undefined;
      // A durable sequence is an event ordinal times its stride, so the oldest
      // row of a Session is at no fixed number and `sequence > 0` cannot answer
      // whether anything precedes the anchor. Ask for one row older instead.
      const older = await this.#handle.loadTranscriptPage({
        source: 'durable',
        direction: 'older',
        throughSequence,
        cursor: null,
        anchorSequence: sequence,
        maxBytes: 1,
      });
      return this.#withDecodedPage(page, (decoded) => {
        if (!this.#isLive() || !isCurrent()) return undefined;
        this.#acceptRange(decoded.messages);
        if (decoded.messages.length > 0 && decoded.messages[0]!.identity !== sequence) {
          throw correlationError('Desktop transcript range did not meet its anchor');
        }
        this.#completeOverlay(decoded.messages);
        return {
          sessionId: this.sessionId,
          generation: this.generation,
          hostEpoch: this.hostEpoch,
          durableThrough: throughSequence,
          durable: decoded.messages.map((entry) => ({
            sequence: entry.identity,
            message: entry.message,
          })),
          overlay: [...this.#overlay.values()],
          hasOlder: older.fragments.length > 0,
          hasNewer: decoded.nextCursor !== null,
        };
      });
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

  trimDurable(targetResidentBytes: number): void {
    this.#assertOpen();
    if (!this.#resident) return;
    this.#evictToBudget(targetResidentBytes);
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
    while (this.#isLive()) {
      const target = this.#targetThrough;
      if (target === null) return;
      const anchorSequence = this.#durableThrough;
      if (anchorSequence !== null && target <= anchorSequence) return;
      let cursor: string | null = null;
      let nextSequence = (anchorSequence ?? -1) + 1;
      // What each publish is spliceable onto: where the read that produced it
      // started, which is the watermark the previous publish ended at.
      let published = anchorSequence;
      do {
        if (!this.#isLive()) return;
        const page: SessionTranscriptPage = await this.#handle.loadTranscriptPage({
          source: 'durable',
          direction: 'newer',
          throughSequence: target,
          cursor,
          anchorSequence: cursor === null ? anchorSequence : null,
          maxBytes: 512 * 1024,
        });
        await this.#withDecodedPage(page, (decoded) => {
          // A concurrent `discard()` (LRU reclaim for another observed session)
          // can flip `#resident` across the `await` above; installing the page
          // would resurrect the reclaimed replica.
          if (!this.#isLive()) return;
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
          this.#installDurable(decoded.messages);
          this.#evictToBudget(
            undefined,
            page.protectedTurnSequence ?? decoded.messages.at(-1)?.identity,
          );
          // The watermark moves with every page, not only at the end: a window
          // opening mid-catch-up takes a snapshot whose rows must agree with the
          // `durableThrough` it names, or the next change cannot join it.
          const through = decoded.messages.at(-1)?.identity ?? published;
          if (through !== null) this.#durableThrough = through;
          this.#publish(published, through, decoded.messages);
          published = through;
          cursor = decoded.nextCursor;
        });
      } while (cursor !== null);
      if (!this.#isLive()) return;
      this.#durableThrough = target;
      this.#publish(published, target, []);
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
  ): void {
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
    }
    this.#completeOverlay(messages);
  }

  /**
   * The durable row settles the overlay it replaces, so the tail cache stops
   * carrying both. Each window retires its own overlay when it installs the
   * row; a window that never installs it keeps showing what it has.
   */
  #completeOverlay(messages: readonly { readonly message: StoredMessage }[]): void {
    for (const { message } of messages) {
      const overlay = this.#overlay.get(message.id);
      if (!overlay) continue;
      this.#overlay.delete(message.id);
      this.#adjustOverlayBytes(-encodedMessageBytes(overlay));
    }
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

  /**
   * A durable sequence is an event ordinal times its stride, so the next row is
   * only ever at or after the previous one plus one — never exactly there.
   */
  #matchesCoverageStep(sequence: number, firstPossibleSequence: number): boolean {
    return sequence >= firstPossibleSequence;
  }

  #publish(
    coversFrom: number | null,
    durableThrough: number | null,
    messages: readonly {
      readonly identity: number;
      readonly message: StoredMessage;
    }[],
  ): void {
    this.#onChange(this, {
      coversFrom,
      durableThrough,
      // Every row this catch-up read, whether or not the tail cache kept it:
      // the budget that evicts it here is Main's, not any window's.
      durableUpserts: messages.map((entry) => ({
        sequence: entry.identity,
        message: entry.message,
      })),
    });
  }

  /**
   * Evicts whole Turns from the oldest edge until the tail fits. The protected
   * Turn and everything newer stay even when they alone exceed the budget: the
   * projector needs the newest Turn complete. Global pressure calls with no
   * protection and may empty the tail.
   */
  #evictToBudget(
    budget: number | undefined = undefined,
    protectedSequence?: number,
  ): void {
    const residentBudget = budget ?? this.#maxResidentBytes + this.#overlayBytes;
    const turns = new Map<string, number[]>();
    for (const sequence of [...this.#durable.keys()].sort((left, right) => left - right)) {
      const key = residentTurnKey(this.#durable.get(sequence)!);
      const group = turns.get(key);
      if (group) group.push(sequence);
      else turns.set(key, [sequence]);
    }
    const protectedEntry = protectedSequence === undefined
      ? undefined
      : this.#durable.get(protectedSequence);
    const protectedKey = protectedEntry === undefined ? undefined : residentTurnKey(protectedEntry);
    let residentTurns = turns.size;
    for (const [key, sequences] of turns) {
      if (this.#residentBytes <= residentBudget && residentTurns <= this.#maxResidentTurns) return;
      if (key === protectedKey) return;
      for (const sequence of sequences) {
        const entry = this.#durable.get(sequence);
        if (!entry) continue;
        this.#durable.delete(sequence);
        this.#adjustResidentBytes(-entry.encodedBytes);
      }
      residentTurns -= 1;
      this.#hasOlder = true;
    }
  }

  #orderedDurable(cloneMessages = true): DesktopSequencedTranscriptMessage[] {
    return [...this.#durable.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => ({
        sequence: entry.sequence,
        message: cloneMessages ? structuredClone(entry.message) : entry.message,
      }));
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

  #isLive(): boolean {
    return !this.#closed && this.#resident;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Desktop transcript replica is closed');
  }

  #assertResident(): void {
    if (!this.#resident) {
      throw new Error('Desktop transcript replica was evicted');
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#operationTail.then(operation);
    this.#operationTail = task.then(() => undefined, () => undefined);
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
