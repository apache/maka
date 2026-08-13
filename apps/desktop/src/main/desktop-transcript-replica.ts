import { randomUUID } from 'node:crypto';
import type { StoredMessage } from '@maka/core/session';
import {
  createRuntimeHostSessionProjectionSeed,
  type RuntimeHostSessionProjectionSeed,
} from '@maka/runtime-host/adapter';
import { RuntimeHostSubscriptionError } from '@maka/runtime-host/client';
import type { SessionTranscriptPage } from '@maka/runtime-host/protocol';
import {
  DESKTOP_TRANSCRIPT_MESSAGE_MAX_BYTES,
  DESKTOP_TRANSCRIPT_SESSION_CACHE_MAX_BYTES,
} from '../preload/transcript-contract.js';
import type { DesktopRuntimeHostSession } from './runtime-host-client.js';

export interface DesktopTranscriptReplicaOptions {
  readonly generation?: string;
  readonly maxMessageBytes?: number;
  readonly maxResidentBytes?: number;
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
  readonly #maxResidentBytes: number;
  readonly #maxMessageBytes: number;
  readonly #onChange: (
    replica: DesktopTranscriptReplica,
    change: DesktopTranscriptReplicaChange,
  ) => void;
  readonly #durable = new Map<number, ResidentMessage>();
  readonly #overlay = new Map<string, StoredMessage>();
  #residentBytes = 0;
  #durableThrough: number | null;
  #targetThrough: number | null;
  #hasOlder: boolean;
  #hasNewer = false;
  #resident = true;
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
      options.maxResidentBytes ?? DESKTOP_TRANSCRIPT_SESSION_CACHE_MAX_BYTES;
    this.#maxMessageBytes = options.maxMessageBytes ?? DESKTOP_TRANSCRIPT_MESSAGE_MAX_BYTES;
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
    const [overlay, durable] = await Promise.all([
      handle.loadTranscriptOverlay(replica.#maxMessageBytes),
      handle.decodeTranscriptPage(
        handle.transcriptBootstrap.durable,
        replica.#maxMessageBytes,
      ),
    ]);
    replica.#installOverlay(overlay);
    replica.#installDurable(durable.messages);
    replica.#hasOlder = durable.nextCursor !== null;
    replica.#evictToBudget();
    if (replica.#residentBytes > replica.#maxResidentBytes) {
      throw new RangeError('Desktop transcript overlay exceeds the session cache limit');
    }
    return replica;
  }

  get residentBytes(): number {
    return this.#residentBytes;
  }

  get resident(): boolean {
    return this.#resident;
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
    const decoded = await this.#handle.decodeTranscriptPage(page, this.#maxMessageBytes);
    this.#assertOpen();
    this.#acceptRange(decoded.messages);
    if (
      anchor !== null &&
      decoded.messages.length > 0 &&
      decoded.messages.at(-1)!.identity !== anchor - 1
    ) {
      throw correlationError('Desktop transcript older page did not meet its anchor');
    }
    const completedOverlayMessageIds = this.#installDurable(decoded.messages);
    this.#hasOlder = decoded.nextCursor !== null;
    const evictedDurableSequences = this.#evictToBudget(this.#maxResidentBytes, 'newest');
    this.#publish(decoded.messages, completedOverlayMessageIds, evictedDurableSequences);
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
    const page = await this.#handle.loadTranscriptPage({
      source: 'durable',
      direction: 'older',
      throughSequence,
      cursor: null,
      anchorSequence: sequence + 1,
      maxBytes,
    });
    const decoded = await this.#handle.decodeTranscriptPage(page, this.#maxMessageBytes);
    this.#assertOpen();
    this.#acceptRange(decoded.messages);
    if (
      decoded.messages.length > 0 &&
      decoded.messages.at(-1)!.identity !== sequence
    ) {
      throw correlationError('Desktop transcript range did not meet its anchor');
    }
    const evictedDurableSequences = [...this.#durable.keys()];
    this.#clearDurable();
    const completedOverlayMessageIds = this.#installDurable(decoded.messages);
    this.#durableThrough = throughSequence;
    this.#hasOlder = decoded.nextCursor !== null;
    this.#hasNewer = sequence < throughSequence;
    evictedDurableSequences.push(...this.#evictToBudget());
    this.#publish(decoded.messages, completedOverlayMessageIds, evictedDurableSequences);
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
    this.#overlay.clear();
    this.#residentBytes = 0;
  }

  close(): void {
    this.#closed = true;
    this.#resident = false;
    this.#durable.clear();
    this.#overlay.clear();
    this.#residentBytes = 0;
  }

  async #catchUp(): Promise<void> {
    while (!this.#closed && this.#resident) {
      const target = this.#targetThrough;
      if (target === null || (this.#durableThrough !== null && target <= this.#durableThrough)) {
        return;
      }
      if (this.#hasNewer) {
        this.#durableThrough = target;
        this.#publish([], [], []);
        return;
      }
      let cursor: string | null = null;
      const anchorSequence = this.#durableThrough;
      let expectedSequence = (anchorSequence ?? -1) + 1;
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
        const decoded = await this.#handle.decodeTranscriptPage(page, this.#maxMessageBytes);
        this.#assertOpen();
        if (!this.#resident) return;
        if (decoded.messages.length === 0 && decoded.nextCursor !== null) {
          throw correlationError('Desktop transcript catch-up returned an empty continuation');
        }
        this.#acceptRange(decoded.messages);
        if (
          decoded.messages.length > 0 &&
          decoded.messages[0]!.identity !== expectedSequence
        ) {
          throw correlationError('Desktop transcript catch-up has a sequence gap');
        }
        if (decoded.messages.length > 0) {
          expectedSequence = decoded.messages.at(-1)!.identity + 1;
        }
        const completedOverlayMessageIds = this.#installDurable(decoded.messages);
        const evictedDurableSequences = this.#evictToBudget();
        this.#publish(decoded.messages, completedOverlayMessageIds, evictedDurableSequences);
        cursor = decoded.nextCursor;
      } while (cursor !== null);
      if (expectedSequence !== target + 1) {
        throw correlationError('Desktop transcript catch-up ended before its watermark');
      }
      this.#durableThrough = target;
      this.#publish([], [], []);
    }
  }

  #installOverlay(messages: readonly StoredMessage[]): void {
    for (const message of messages) {
      const previous = this.#overlay.get(message.id);
      if (previous) this.#residentBytes -= encodedMessageBytes(previous);
      this.#overlay.set(message.id, message);
      this.#residentBytes += encodedMessageBytes(message);
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
      if (previous) this.#residentBytes -= previous.encodedBytes;
      const message = structuredClone(item.message);
      const encodedBytes = encodedMessageBytes(message);
      this.#durable.set(item.identity, {
        sequence: item.identity,
        message,
        encodedBytes,
      });
      this.#residentBytes += encodedBytes;
      const overlay = this.#overlay.get(message.id);
      if (overlay) {
        this.#overlay.delete(message.id);
        this.#residentBytes -= encodedMessageBytes(overlay);
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
      if (current !== previous + 1) {
        throw correlationError('Desktop transcript page has a sequence gap');
      }
    }
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
    budget = this.#maxResidentBytes,
    edge: 'oldest' | 'newest' = 'oldest',
  ): number[] {
    const evicted: number[] = [];
    const direction = edge === 'oldest' ? 1 : -1;
    for (const sequence of [...this.#durable.keys()].sort((left, right) => direction * (left - right))) {
      if (this.#residentBytes <= budget) break;
      const entry = this.#durable.get(sequence);
      if (!entry) continue;
      this.#durable.delete(sequence);
      this.#residentBytes -= entry.encodedBytes;
      if (edge === 'oldest') this.#hasOlder = true;
      else this.#hasNewer = true;
      evicted.push(sequence);
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
    for (const entry of this.#durable.values()) this.#residentBytes -= entry.encodedBytes;
    this.#durable.clear();
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

function correlationError(message: string): RuntimeHostSubscriptionError {
  return new RuntimeHostSubscriptionError('correlation_changed', message);
}
