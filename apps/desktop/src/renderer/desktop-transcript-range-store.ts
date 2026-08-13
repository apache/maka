import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import type {
  DesktopTranscriptBatch,
  DesktopTranscriptFragment,
  DesktopTranscriptHandle,
} from '../preload/transcript-contract.js';

export interface DesktopTranscriptRangeController {
  readonly store: DesktopTranscriptRangeStore;
  ready(): Promise<void>;
  waitForDurableMessage(messageId: string, timeoutMs: number): Promise<boolean>;
  loadBefore(): Promise<void>;
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
    async loadBefore() {
      const range = store.range();
      if (!range.hasOlder) return;
      await (await current()).loadBefore(range.oldestSequence);
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

interface PendingRecord {
  readonly source: 'durable' | 'overlay';
  readonly identity: number | string;
  readonly order: number | null;
  readonly totalBytes: number;
  readonly chunks: Map<number, Uint8Array>;
  receivedBytes: number;
}

interface StoredRecord {
  readonly message: StoredMessage;
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
  readonly #durable = new Map<number, StoredRecord>();
  readonly #overlay = new Map<string, OverlayRecord>();
  readonly #pending = new Map<string, PendingRecord>();
  #sessionId: string | undefined;
  #generation: string | undefined;
  #hostEpoch: string | undefined;
  #durableThrough: number | null = null;
  #oldestSequence: number | null = null;
  #newestSequence: number | null = null;
  #hasOlder = false;
  #hasNewer = false;
  #ready = false;
  #batchChanged = false;
  readonly #durableWaiters = new Set<() => void>();

  accept(batch: DesktopTranscriptBatch): boolean {
    if (batch.reset) this.#reset(batch);
    if (
      batch.sessionId !== this.#sessionId ||
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
        this.#refreshSequenceBounds(sequence);
        changed = true;
      }
    }
    for (const messageId of batch.completedOverlayMessageIds) {
      changed = this.#overlay.delete(messageId) || changed;
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
    for (const notify of this.#durableWaiters) notify();
    return committed;
  }

  snapshot(): DesktopTranscriptRangeSnapshot {
    const range = this.range();
    const durable = [...this.#durable.entries()].sort(([left], [right]) => left - right);
    const overlay = [...this.#overlay.values()].sort((left, right) => left.order - right.order);
    return {
      ...range,
      messages: durable
        .map(([, record]) => structuredClone(record.message))
        .concat(overlay.map((record) => structuredClone(record.message))),
    };
  }

  range(): DesktopTranscriptRangeState {
    if (!this.#sessionId || !this.#generation || !this.#hostEpoch) {
      throw new Error('Desktop transcript range is not initialized');
    }
    return {
      sessionId: this.#sessionId,
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

  #reset(batch: DesktopTranscriptBatch): void {
    this.#durable.clear();
    this.#overlay.clear();
    this.#pending.clear();
    this.#sessionId = batch.sessionId;
    this.#generation = batch.generation;
    this.#hostEpoch = batch.hostEpoch;
    this.#durableThrough = batch.durableThrough;
    this.#oldestSequence = null;
    this.#newestSequence = null;
    this.#hasOlder = batch.hasOlder;
    this.#hasNewer = batch.hasNewer;
    this.#ready = false;
    this.#batchChanged = false;
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
        chunks: new Map(),
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
    const previous = pending.chunks.get(fragment.byteOffset);
    if (previous) {
      if (!equalBytes(previous, bytes)) {
        throw new Error('Desktop transcript fragment changed during replay');
      }
      return false;
    }
    for (const [offset, chunk] of pending.chunks) {
      if (
        fragment.byteOffset < offset + chunk.byteLength &&
        offset < fragment.byteOffset + bytes.byteLength
      ) {
        throw new Error('Desktop transcript fragments overlap');
      }
    }
    pending.chunks.set(fragment.byteOffset, bytes);
    pending.receivedBytes += bytes.byteLength;
    if (pending.receivedBytes < pending.totalBytes) return false;
    const encoded = assembleRecord(pending);
    const message = decodeStoredMessage(JSON.parse(encoded) as unknown);
    this.#pending.delete(key);
    if (pending.source === 'durable') {
      if (!Number.isSafeInteger(pending.identity) || (pending.identity as number) < 0) {
        throw new Error('Invalid Desktop transcript durable identity');
      }
      const sequence = pending.identity as number;
      const existing = this.#durable.get(sequence);
      if (existing && JSON.stringify(existing.message) !== encoded) {
        throw new Error('Desktop transcript durable record changed');
      }
      this.#durable.set(sequence, { message });
      this.#oldestSequence = Math.min(this.#oldestSequence ?? sequence, sequence);
      this.#newestSequence = Math.max(this.#newestSequence ?? sequence, sequence);
      return !existing;
    }
    if (typeof pending.identity !== 'string' || message.id !== pending.identity) {
      throw new Error('Desktop transcript overlay identity changed');
    }
    if (pending.order === null || !Number.isSafeInteger(pending.order) || pending.order < 0) {
      throw new Error('Invalid Desktop transcript overlay order');
    }
    const existing = this.#overlay.get(pending.identity);
    this.#overlay.set(pending.identity, {
      message,
      order: pending.order,
    });
    return (
      !existing ||
      JSON.stringify(existing.message) !== encoded ||
      existing.order !== pending.order
    );
  }

  #refreshSequenceBounds(deletedSequence: number): void {
    if (deletedSequence !== this.#oldestSequence && deletedSequence !== this.#newestSequence) return;
    this.#oldestSequence = null;
    this.#newestSequence = null;
    for (const sequence of this.#durable.keys()) {
      this.#oldestSequence = Math.min(this.#oldestSequence ?? sequence, sequence);
      this.#newestSequence = Math.max(this.#newestSequence ?? sequence, sequence);
    }
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function assembleRecord(record: PendingRecord): string {
  const chunks = [...record.chunks.entries()].sort(([left], [right]) => left - right);
  const bytes = new Uint8Array(record.totalBytes);
  let expectedOffset = 0;
  for (const [offset, chunk] of chunks) {
    if (offset !== expectedOffset) throw new Error('Desktop transcript record has a fragment gap');
    bytes.set(chunk, offset);
    expectedOffset += chunk.byteLength;
  }
  if (expectedOffset !== record.totalBytes) {
    throw new Error('Desktop transcript record is incomplete');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
