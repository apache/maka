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
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  type SessionTranscriptPage,
} from '@maka/runtime-host/protocol';
import {
  DESKTOP_TRANSCRIPT_MESSAGE_MAX_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_MAX_TURNS,
} from '../preload/transcript-contract.js';
import type { DesktopRuntimeHostSession } from './runtime-host-client.js';

export interface DesktopTranscriptReplicaOptions {
  readonly generation?: string;
  readonly maxMessageBytes?: number;
  readonly maxResidentBytes?: number;
  readonly maxResidentTurns?: number;
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
  readonly hasOlder: boolean;
  /**
   * Whether the oldest Turn in the tail has all its rows here. The tail is
   * bounded by bytes, so it can begin inside a Turn — what it holds of that
   * Turn then says nothing about how much of it exists.
   */
  readonly beginsAtTurnBoundary: boolean;
}

/** One durable page read for a history consumer; never installed here. Rows ascend. */
export interface DesktopTranscriptHistoryPage {
  readonly durable: readonly DesktopSequencedTranscriptMessage[];
  readonly nextCursor: string | null;
  /** Whether the Host holds nothing more of the Turns this page carries rows of. */
  readonly endsAtTurnBoundary: boolean;
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
 * Main's view of one Session transcript: the durable tail the projector needs
 * and pass-through reads of older history. This class only keeps the tail
 * current and answers those reads.
 */
export class DesktopTranscriptReplica {
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly #handle: DesktopRuntimeHostSession;
  readonly #maxResidentBytes: number;
  readonly #maxResidentTurns: number;
  readonly #maxMessageBytes: number;
  readonly #accountPreparationBytes: (deltaBytes: number) => void;
  readonly #onChange: (
    replica: DesktopTranscriptReplica,
    change: DesktopTranscriptReplicaChange,
  ) => void;
  readonly #durable = new Map<number, ResidentMessage>();
  #residentBytes = 0;
  #durableThrough: number | null;
  #targetThrough: number | null;
  #hasOlder: boolean;
  #beginsAtTurnBoundary: boolean;
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
      options.maxResidentBytes ?? DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES;
    this.#maxResidentTurns =
      options.maxResidentTurns ?? DESKTOP_TRANSCRIPT_TAIL_MAX_TURNS;
    this.#maxMessageBytes = options.maxMessageBytes ?? DESKTOP_TRANSCRIPT_MESSAGE_MAX_BYTES;
    this.#accountPreparationBytes = options.accountPreparationBytes ?? (() => undefined);
    this.#onChange = options.onChange ?? (() => undefined);
    this.#durableThrough = handle.transcriptBootstrap.durable.throughSequence;
    this.#targetThrough = this.#durableThrough;
    this.#hasOlder = handle.transcriptBootstrap.durable.nextCursor !== null;
    this.#beginsAtTurnBoundary = handle.transcriptBootstrap.durable.endsAtTurnBoundary;
  }

  static async prepare(
    handle: DesktopRuntimeHostSession,
    options: DesktopTranscriptReplicaOptions = {},
  ): Promise<DesktopTranscriptReplica> {
    const replica = new DesktopTranscriptReplica(handle, options);
    try {
      await replica.#withDecodedPage(handle.transcriptBootstrap.durable, (durable) => {
        replica.#installDurable(durable.messages);
        replica.#hasOlder = durable.nextCursor !== null;
      });
      replica.#evictToBudget();
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
      hasOlder: this.#hasOlder,
      beginsAtTurnBoundary: this.#beginsAtTurnBoundary,
    };
  }

  messages(): StoredMessage[] {
    this.#assertOpen();
    this.#assertResident();
    return this.#orderedDurable().map((entry) => entry.message);
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

  /** One page older than `cursor`, or the newest page through `throughSequence` when it is null. */
  async readOlderPage(
    throughSequence: number,
    cursor: string | null,
  ): Promise<DesktopTranscriptHistoryPage> {
    this.#assertLive();
    const page = await this.#handle.loadTranscriptPage({
      direction: 'older',
      throughSequence,
      cursor,
      anchorSequence: null,
      maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
    });
    return this.#withDecodedPage(page, (decoded) => {
      this.#assertLive();
      this.#acceptRange(decoded.messages);
      return {
        durable: decoded.messages.map((entry) => ({
          sequence: entry.identity,
          message: entry.message,
        })),
        nextCursor: decoded.nextCursor,
        endsAtTurnBoundary: page.endsAtTurnBoundary,
      };
    });
  }

  /**
   * Every durable row of one Turn this replica's watermark covers, read
   * forward across the extent the Host's Turn index gives it. Only the Turn's
   * own rows count toward `maxBytes`: a nested Turn's rows sit inside the
   * extent of the Turn around it.
   */
  async readTurn(
    turnId: string,
    extent: { readonly sequence: number; readonly lastSequence: number },
    maxBytes: number,
  ): Promise<StoredMessage[]> {
    this.#assertLive();
    const firstSequence = extent.sequence;
    const throughSequence =
      this.#durableThrough === null ? null : Math.min(this.#durableThrough, extent.lastSequence);
    const durable: StoredMessage[] = [];
    let bytes = 0;
    let cursor: string | null = null;
    let nextSequence = firstSequence;
    if (throughSequence !== null && firstSequence <= throughSequence) {
      do {
        const page: SessionTranscriptPage = await this.#handle.loadTranscriptPage({
          direction: 'newer',
          throughSequence,
          cursor,
          anchorSequence: cursor === null && firstSequence > 0 ? firstSequence - 1 : null,
          maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
        });
        await this.#withDecodedPage(page, (decoded) => {
          this.#assertLive();
          if (decoded.messages.length === 0 && decoded.nextCursor !== null) {
            throw correlationError('Desktop transcript Turn read returned an empty continuation');
          }
          this.#acceptRange(decoded.messages);
          const first = decoded.messages[0];
          if (first && !this.#matchesCoverageStep(first.identity, nextSequence)) {
            throw correlationError('Desktop transcript Turn read has a sequence gap');
          }
          nextSequence = (decoded.messages.at(-1)?.identity ?? nextSequence - 1) + 1;
          for (const { message } of decoded.messages) {
            if (messageTurnId(message) !== turnId) continue;
            bytes += encodedMessageBytes(message);
            if (bytes > maxBytes) throw new RangeError('Desktop transcript Turn exceeds its read limit');
            durable.push(message);
          }
          cursor = decoded.nextCursor;
        });
      } while (cursor !== null);
    }
    return durable;
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
  }

  close(): void {
    this.#closed = true;
    this.#resident = false;
    this.#durable.clear();
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
          direction: 'newer',
          throughSequence: target,
          cursor,
          anchorSequence: cursor === null ? anchorSequence : null,
          maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
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
          this.#evictToBudget();
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
   * Evicts whole Turns from the oldest edge until the tail fits. The newest
   * Turn stays even when it alone exceeds the budget: the projector needs it
   * complete. Global pressure passes a budget and may empty the tail.
   */
  #evictToBudget(budget?: number): void {
    const residentBudget = budget ?? this.#maxResidentBytes;
    const turns = new Map<string, number[]>();
    const sequences = [...this.#durable.keys()].sort((left, right) => left - right);
    for (const sequence of sequences) {
      const key = residentTurnKey(this.#durable.get(sequence)!);
      const group = turns.get(key);
      if (group) group.push(sequence);
      else turns.set(key, [sequence]);
    }
    // A trailing Session note is not the Turn the projector needs to keep whole.
    const keys = [...turns.keys()];
    const protectedKey = budget === undefined
      ? [...keys].reverse().find((key) => key.startsWith('turn:')) ?? keys.at(-1)
      : undefined;
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
      // Eviction groups rows by their owner, which is not where a Turn ends
      // when another Turn's rows are written between them.
      this.#beginsAtTurnBoundary = false;
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

  #assertLive(): void {
    this.#assertOpen();
    this.#assertResident();
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
