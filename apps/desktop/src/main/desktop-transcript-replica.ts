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
  type DesktopTranscriptNavigation,
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
  readonly navigationVersion?: number;
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
  #overlaySettledThrough: number | null;
  #targetThrough: number | null;
  #hasOlder: boolean;
  #hasNewer = false;
  #resident = true;
  #residentExternallyAccounted = true;
  #closed = false;
  #catchUpTask: Promise<void> | undefined;
  #operationTail = Promise.resolve();
  #navigationToken = 0;
  #intent: DesktopTranscriptNavigation['intent'] = 'followTail';
  #readingAnchorSequence: number | undefined;
  #readingAnchorTurnId: string | undefined;
  #adjacentReadingSequence: number | undefined;

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
      options.maxResidentTurns ?? DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS;
    this.#maxOverlayBytes =
      options.maxOverlayBytes ?? DESKTOP_TRANSCRIPT_OVERLAY_CACHE_MAX_BYTES;
    this.#maxMessageBytes = options.maxMessageBytes ?? SESSION_TRANSCRIPT_RANGE_MAX_BYTES;
    this.#accountPreparationBytes = options.accountPreparationBytes ?? (() => undefined);
    this.#onChange = options.onChange ?? (() => undefined);
    this.#durableThrough = handle.transcriptBootstrap.throughSequence;
    this.#overlaySettledThrough = this.#durableThrough;
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

  setNavigation(intent: DesktopTranscriptNavigation['intent']): number {
    this.#assertOpen();
    this.#intent = intent;
    if (intent === 'followTail') {
      this.#readingAnchorSequence = undefined;
      this.#readingAnchorTurnId = undefined;
      this.#adjacentReadingSequence = undefined;
    }
    return ++this.#navigationToken;
  }

  readAt(
    sequence: number | null,
    token = this.setNavigation('history'),
    readingTurnId?: string,
  ): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#isNavigationCurrent(token)) return;
      let anchor = readingTurnId === undefined
        ? sequence
        : this.#sequenceForTurn(readingTurnId) ?? sequence;
      const through = this.#targetThrough ?? this.#durableThrough;
      if (anchor === null && readingTurnId !== undefined && through !== null &&
        !(through <= (this.#overlaySettledThrough ?? -1) &&
          [...this.#overlay.values()].some((message) => message.turnId === readingTurnId))) {
        // After reconnect, an overlay-only bookmark may already be durable and
        // outside the bootstrap tail. Locate it through the existing bounded
        // pager; retaining only its sequence keeps the scan's memory bounded.
        anchor = await this.#findTurnSequence(readingTurnId, through, token);
      }
      if (!this.#isNavigationCurrent(token)) return;
      if (anchor === null) {
        // Active RuntimeEvent invocations have no durable sequence. Put the
        // durable range at its current tail, then protect the requested Turn
        // when catch-up first projects it. Never borrow another Turn's anchor.
        if (through !== null && this.#hasNewer) {
          await this.#replaceWithRange(through, through, this.#maxResidentBytes, token);
        }
        if (!this.#isNavigationCurrent(token)) return;
        this.#readingAnchorTurnId = readingTurnId;
        this.#readingAnchorSequence = undefined;
        this.#adjacentReadingSequence = undefined;
        this.#publish([], [], []);
        return;
      }
      if (!this.#durable.has(anchor)) {
        if (through !== null && anchor <= through) {
          await this.#replaceWithRange(through, anchor, this.#maxResidentBytes, token);
        }
        return;
      }
      this.#readingAnchorSequence = anchor;
      this.#readingAnchorTurnId = readingTurnId ?? this.#durable.get(anchor)?.message.turnId;
      this.#adjacentReadingSequence = undefined;
      const evicted = this.#evictToBudget(undefined, 'newest', anchor);
      this.#publish([], [], evicted);
    });
  }

  #sequenceForTurn(turnId: string): number | undefined {
    for (const entry of this.#orderedDurable(false)) {
      if (entry.message.turnId === turnId) return entry.sequence;
    }
    return undefined;
  }

  #resolveReadingAnchor(): number | undefined {
    if (this.#readingAnchorTurnId !== undefined) {
      this.#readingAnchorSequence = this.#sequenceForTurn(this.#readingAnchorTurnId)
        ?? this.#readingAnchorSequence;
    }
    return this.#readingAnchorSequence;
  }

  #awaitingReadingTurn(): boolean {
    return this.#readingAnchorTurnId !== undefined && this.#resolveReadingAnchor() === undefined;
  }

  async #findTurnSequence(turnId: string, throughSequence: number, token: number): Promise<number | null> {
    let cursor: string | null = null;
    do {
      if (!this.#isNavigationCurrent(token)) return null;
      const page = await this.#handle.loadTranscriptPage({
        source: 'durable', direction: 'older', throughSequence,
        cursor, anchorSequence: null, maxBytes: this.#maxResidentBytes,
      });
      let sequence: number | undefined;
      await this.#withDecodedPage(page, (decoded) => {
        if (!this.#isNavigationCurrent(token)) return;
        sequence = decoded.messages.find((entry) => entry.message.turnId === turnId)?.identity;
        cursor = decoded.nextCursor;
      });
      if (!this.#isNavigationCurrent(token)) return null;
      if (sequence !== undefined) return sequence;
    } while (cursor !== null);
    return null;
  }

  async followLatest(maxBytes: number, token = this.setNavigation('followTail')): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#isNavigationCurrent(token)) return;
      const through = this.#targetThrough ?? this.#durableThrough;
      if (through !== null) await this.#replaceWithRange(through, through, maxBytes, token);
    });
  }

  async loadBefore(
    anchorSequence: number | null,
    maxBytes: number,
    token = this.setNavigation('history'),
  ): Promise<void> {
    return this.#enqueue(() => this.#loadAdjacent('older', anchorSequence, maxBytes, token));
  }

  async loadAfter(
    anchorSequence: number | null,
    maxBytes: number,
    token = this.setNavigation('history'),
  ): Promise<void> {
    return this.#enqueue(() => this.#loadAdjacent('newer', anchorSequence, maxBytes, token));
  }

  async #loadAdjacent(
    direction: 'older' | 'newer',
    anchorSequence: number | null,
    maxBytes: number,
    token: number,
  ): Promise<void> {
    if (!this.#isNavigationCurrent(token)) return;
    const throughSequence = this.#durableThrough;
    if (throughSequence === null) return;
    const anchor = anchorSequence ?? (direction === 'older'
      ? this.#oldestSequence()
      : this.#orderedDurable(false).at(-1)?.sequence ?? null);
    const page = await this.#handle.loadTranscriptPage({
      source: 'durable',
      direction,
      throughSequence,
      cursor: null,
      anchorSequence: anchor,
      maxBytes,
    });
    await this.#withDecodedPage(page, (decoded) => {
      if (!this.#isNavigationCurrent(token)) return;
      // Same post-await `#resident` invariant as `#replaceWithRange` and the
      // paged catch-up: a concurrent `discard()` may have reclaimed this
      // replica while the adjacent page was in flight. Installing the page here
      // would repopulate durable state and undo the eviction.
      if (!this.#resident) return;
      this.#acceptRange(decoded.messages);
      if (
        anchor !== null &&
        decoded.messages.length > 0 &&
        !(direction === 'older'
          ? this.#matchesCoverageStep(anchor, decoded.messages.at(-1)!.identity + 1)
          : this.#matchesCoverageStep(decoded.messages[0]!.identity, anchor + 1))
      ) {
        throw correlationError(`Desktop transcript ${direction} page did not meet its anchor`);
      }
      const completedOverlayMessageIds = this.#installDurable(decoded.messages);
      if (direction === 'older') this.#hasOlder = decoded.nextCursor !== null;
      else this.#hasNewer = decoded.nextCursor !== null;
      const anchorTurnId = anchor === null ? undefined : this.#durable.get(anchor)?.message.turnId;
      const towardEdge = direction === 'older' ? [...decoded.messages].reverse() : decoded.messages;
      const adjacent = towardEdge.find(({ message }) =>
        messageTurnId(message) !== undefined && messageTurnId(message) !== anchorTurnId,
      ) ?? towardEdge.at(-1);
      this.#readingAnchorSequence = anchor ?? undefined;
      this.#readingAnchorTurnId = anchorTurnId;
      this.#adjacentReadingSequence = adjacent?.identity;
      const evictedDurableSequences = this.#evictToBudget(
        undefined,
        direction === 'older' ? 'newest' : 'oldest',
        anchor ?? undefined,
        adjacent?.identity,
      );
      this.#publish(decoded.messages, completedOverlayMessageIds, evictedDurableSequences);
    });
  }

  async loadAround(
    sequence: number,
    maxBytes: number,
    token = this.setNavigation('history'),
  ): Promise<void> {
    return this.#enqueue(() => this.#loadAround(sequence, maxBytes, token));
  }

  async #loadAround(sequence: number, maxBytes: number, token: number): Promise<void> {
    if (!this.#isNavigationCurrent(token)) return;
    const throughSequence = this.#durableThrough;
    if (throughSequence === null || sequence > throughSequence) return;
    await this.#replaceWithRange(throughSequence, sequence, maxBytes, token);
  }

  async #replaceWithRange(
    throughSequence: number,
    sequence: number,
    maxBytes: number,
    token: number,
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
    if (!this.#isNavigationCurrent(token)) return;
    // A navigation target is a reading position, not a range boundary. Keep a
    // bounded page on its older side too, so the first upward gesture after a
    // prompt-rail jump moves through resident Turns instead of racing a prepend.
    // A durable sequence is an event ordinal times its stride, so only an older
    // page can also say whether this target is the start of the Session.
    const older = loadTail
      ? null
      : await this.#handle.loadTranscriptPage({
          source: 'durable',
          direction: 'older',
          throughSequence,
          cursor: null,
          anchorSequence: sequence,
          maxBytes,
        });
    let decodedOlder: Awaited<ReturnType<DesktopRuntimeHostSession['decodeTranscriptPage']>>
      | undefined;
    if (older) {
      await this.#withDecodedPage(older, (decoded) => {
        this.#acceptRange(decoded.messages);
        const lastOlder = decoded.messages.at(-1);
        if (lastOlder && !this.#matchesCoverageStep(sequence, lastOlder.identity + 1)) {
          throw correlationError('Desktop transcript older range crossed its anchor');
        }
        decodedOlder = decoded;
      });
    }
    await this.#withDecodedPage(page, (decoded) => {
      if (!this.#isNavigationCurrent(token)) return;
      // `#resident` can flip to false across the `await` above (a concurrent
      // `discard()` reclaims memory for a non-visible session while the page is
      // in flight). Re-anchoring here would repopulate durable state and undo
      // the eviction, resurrecting a deliberately discarded replica past its
      // memory budget. The paged catch-up guards its own post-await callback
      // the same way; mirror it before mutating or publishing.
      if (!this.#resident) return;
      const messages = decodedOlder
        ? [...decodedOlder.messages, ...decoded.messages]
        : decoded.messages;
      this.#acceptRange(messages);
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
      const completedOverlayMessageIds = this.#installDurable(messages);
      this.#durableThrough = throughSequence;
      this.#readingAnchorSequence = this.#intent === 'history' ? sequence : undefined;
      this.#readingAnchorTurnId = this.#intent === 'history'
        ? this.#durable.get(sequence)?.message.turnId : undefined;
      this.#adjacentReadingSequence = undefined;
      this.#hasOlder = loadTail ? decoded.nextCursor !== null : decodedOlder!.nextCursor !== null;
      this.#hasNewer = loadTail ? false : decoded.nextCursor !== null;
      evictedDurableSequences.push(
        ...this.#evictToBudget(
          undefined,
          loadTail ? 'oldest' : 'newest',
          loadTail ? (page.protectedTurnSequence ?? sequence) : sequence,
        ),
      );
      this.#publish(messages, completedOverlayMessageIds, evictedDurableSequences);
    });
    if (this.#isNavigationCurrent(token) && this.#needsOverlaySettlement(throughSequence)) {
      await this.#settleOverlayThrough(throughSequence, token);
    }
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
        (this.#durableThrough === null || this.#targetThrough > this.#durableThrough ||
          this.#needsOverlaySettlement(this.#targetThrough))
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
      if (target === null) return;
      if (
        this.#durableThrough !== null && target <= this.#durableThrough &&
        !this.#needsOverlaySettlement(target)
      ) return;
      const token = this.#navigationToken;
      if (
        (this.#durableThrough !== null && target <= this.#durableThrough) ||
        (this.#intent === 'history' && this.#hasNewer && !this.#awaitingReadingTurn())
      ) {
        await this.#settleOverlayThrough(target, token);
        if (!this.#isNavigationCurrent(token)) return;
        if (this.#durableThrough !== null && target <= this.#durableThrough) return;
        this.#durableThrough = target;
        this.#publish([], [], []);
        return;
      }
      if (this.#hasNewer && !this.#awaitingReadingTurn()) {
        await this.#replaceWithRange(target, target, DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES, token);
        return;
      }
      let cursor: string | null = null;
      const anchorSequence = this.#durableThrough;
      let nextSequence = (anchorSequence ?? -1) + 1;
      do {
        if (!this.#isNavigationCurrent(token)) return;
        const page: SessionTranscriptPage = await this.#handle.loadTranscriptPage({
          source: 'durable',
          direction: 'newer',
          throughSequence: target,
          cursor,
          anchorSequence: cursor === null ? anchorSequence : null,
          maxBytes: 512 * 1024,
        });
        await this.#withDecodedPage(page, (decoded) => {
          if (!this.#isNavigationCurrent(token)) return;
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
          this.#acknowledgeOverlayCoverage(anchorSequence, decoded.messages.at(-1)?.identity);
          // Reading the start of the still-growing latest Turn must continue
          // receiving its durable text. Preserve the reader's anchor (and an
          // older page awaiting the reader), rather than protecting a new Turn
          // that could evict the range they are reading.
          const readingHistory = this.#intent === 'history';
          const readingSequence = readingHistory ? this.#resolveReadingAnchor() : undefined;
          const awaitingReadingTurn = readingHistory && this.#awaitingReadingTurn();
          const evictedDurableSequences = this.#evictToBudget(
            undefined,
            readingHistory && !awaitingReadingTurn ? 'newest' : 'oldest',
            readingHistory && !awaitingReadingTurn
              ? readingSequence ?? this.#oldestSequence() ?? undefined
              : page.protectedTurnSequence ?? decoded.messages.at(-1)?.identity,
            readingHistory ? this.#adjacentReadingSequence : undefined,
          );
          this.#publish(decoded.messages, completedOverlayMessageIds, evictedDurableSequences);
          cursor = decoded.nextCursor;
        });
        if (!this.#isNavigationCurrent(token)) return;
        if (this.#intent === 'history' && this.#hasNewer && !this.#awaitingReadingTurn()) {
          await this.#settleOverlayThrough(target, token);
          if (!this.#isNavigationCurrent(token)) return;
          this.#durableThrough = target;
          this.#publish([], [], []);
          return;
        }
      } while (cursor !== null);
      // A concurrent `discard()` (LRU reclaim for another observed session) can
      // flip `#resident` to false across any page `await` above. The per-page
      // callback already returns early in that case, so `nextSequence` is
      // left short of the watermark. Without this guard the check below would
      // turn a benign memory reclaim into a fatal `correlation_changed` that
      // drives the session terminal. A discarded replica has no watermark to
      // meet, so return cleanly and let a later resume re-catch-up.
      if (!this.#isNavigationCurrent(token)) return;
      this.#acknowledgeOverlayCoverage(anchorSequence, target);
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

  #needsOverlaySettlement(throughSequence: number): boolean {
    return this.#overlay.size > 0 &&
      (this.#overlaySettledThrough === null || throughSequence > this.#overlaySettledThrough);
  }

  #acknowledgeOverlayCoverage(anchorSequence: number | null, throughSequence: number | undefined): void {
    if (
      throughSequence !== undefined &&
      (anchorSequence ?? -1) <= (this.#overlaySettledThrough ?? -1)
    ) {
      this.#overlaySettledThrough = Math.max(this.#overlaySettledThrough ?? -1, throughSequence);
    }
  }

  async #settleOverlayThrough(throughSequence: number, token: number): Promise<void> {
    // A navigation can skip durable pages while the bootstrap overlay still
    // contains an unfinished message from one of those pages. Its settlement
    // watermark must therefore be independent of the visible range watermark.
    // Only matching durable identities retire overlay records; unrelated new
    // messages are decoded one page at a time without entering the range.
    if (!this.#needsOverlaySettlement(throughSequence)) return;
    const anchorSequence = this.#overlaySettledThrough;
    let nextSequence = (anchorSequence ?? -1) + 1;
    let cursor: string | null = null;
    do {
      if (!this.#isNavigationCurrent(token)) return;
      const page = await this.#handle.loadTranscriptPage({
        source: 'durable',
        direction: 'newer',
        throughSequence,
        cursor,
        anchorSequence: cursor === null ? anchorSequence : null,
        maxBytes: 512 * 1024,
      });
      await this.#withDecodedPage(page, (decoded) => {
        if (!this.#isNavigationCurrent(token)) return;
        if (decoded.messages.length === 0 && decoded.nextCursor !== null) {
          throw correlationError('Desktop transcript overlay settlement returned an empty continuation');
        }
        this.#acceptRange(decoded.messages);
        if (decoded.messages.length > 0) {
          if (!this.#matchesCoverageStep(decoded.messages[0]!.identity, nextSequence)) {
            throw correlationError('Desktop transcript overlay settlement has a sequence gap');
          }
          const lastSequence = decoded.messages.at(-1)!.identity;
          nextSequence = lastSequence + 1;
          this.#overlaySettledThrough = lastSequence;
        }
        const completedOverlayMessageIds = this.#completeOverlay(decoded.messages);
        if (completedOverlayMessageIds.length > 0) {
          this.#publish([], completedOverlayMessageIds, []);
        }
        cursor = decoded.nextCursor;
      });
      if (!this.#isNavigationCurrent(token) || this.#overlay.size === 0) return;
    } while (cursor !== null);
    // RuntimeEvent projection can leave gaps and a watermark beyond its last
    // visible row. Exhausting the correlated cursor establishes coverage.
    this.#overlaySettledThrough = throughSequence;
  }

  #installDurable(
    messages: readonly {
      readonly identity: number;
      readonly message: StoredMessage;
    }[],
  ): string[] {
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
    return this.#completeOverlay(messages);
  }

  #completeOverlay(messages: readonly { readonly message: StoredMessage }[]): string[] {
    const completedOverlayMessageIds: string[] = [];
    for (const { message } of messages) {
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

  /**
   * A durable sequence is an event ordinal times its stride, so the next row is
   * only ever at or after the previous one plus one — never exactly there.
   */
  #matchesCoverageStep(sequence: number, firstPossibleSequence: number): boolean {
    return sequence >= firstPossibleSequence;
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
    protectedThroughSequence = protectedSequence,
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
    const protectedIndices = [protectedSequence, protectedThroughSequence].flatMap((sequence) => {
      const entry = sequence === undefined ? undefined : this.#durable.get(sequence);
      return entry === undefined ? [] : [orderedTurns.findIndex(([key]) => key === residentTurnKey(entry))];
    });
    const protectedStart = Math.min(...protectedIndices);
    const protectedEnd = Math.max(...protectedIndices);
    // A single oversized Turn already outranks the per-range soft budget.
    // Adjacent navigation needs the same exception for the minimal span from
    // the reader to the next Turn; otherwise that Turn is evicted on arrival
    // and every subsequent scroll reloads it without making progress. Global
    // pressure calls trimDurable without protection and still reclaims it.
    const take = (
      candidateEdge: 'oldest' | 'newest',
    ): readonly [string, number[]] | undefined => {
      const index = candidateEdge === 'oldest' ? oldestIndex : newestIndex;
      if (oldestIndex > newestIndex) return undefined;
      const turn = orderedTurns[index];
      if (!turn || (index >= protectedStart && index <= protectedEnd)) return undefined;
      if (candidateEdge === 'oldest') oldestIndex += 1;
      else newestIndex -= 1;
      return turn;
    };
    while (
      this.#residentBytes > residentBudget
      || residentTurns > this.#maxResidentTurns
    ) {
      let evictionEdge = protectedIndices.length === 0
        ? edge
        : protectedStart - oldestIndex > newestIndex - protectedEnd
          ? 'oldest'
          : protectedStart - oldestIndex < newestIndex - protectedEnd
            ? 'newest'
            : edge;
      let turn = take(evictionEdge);
      if (turn === undefined) {
        evictionEdge = evictionEdge === 'oldest' ? 'newest' : 'oldest';
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

  #isNavigationCurrent(token: number): boolean {
    return !this.#closed && this.#resident && token === this.#navigationToken;
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
