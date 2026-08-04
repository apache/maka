import { randomUUID } from 'node:crypto';
import type { StoredMessage } from '@maka/core/session';
import {
  SESSION_TRANSCRIPT_CHUNK_MAX_BYTES,
  type SessionTranscriptCursor,
  type SessionTranscriptQueryResult,
} from '../protocol/index.js';

const MAX_CONNECTION_SNAPSHOTS = 4;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_IDLE_MS = 60_000;

interface TranscriptSnapshot {
  id: string;
  connectionId: string;
  subscriptionId: string;
  sessionId: string;
  messages: readonly Buffer[];
  encodedBytes: number;
  lastAccessAt: number;
}

export type TranscriptSnapshotQueryOutcome =
  | { ok: true; result: SessionTranscriptQueryResult }
  | {
      ok: false;
      error: {
        code: 'invalid_request' | 'operation_conflict' | 'operation_unavailable';
        message: string;
      };
    };

export class TranscriptSnapshotStore {
  readonly #snapshots = new Map<string, TranscriptSnapshot>();
  readonly #now: () => number;
  #cleanupTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  start(input: {
    connectionId: string;
    subscriptionId: string;
    sessionId: string;
    messages: readonly StoredMessage[];
  }): TranscriptSnapshotQueryOutcome {
    this.#pruneExpired();
    let connectionSnapshots = 0;
    for (const snapshot of this.#snapshots.values()) {
      if (snapshot.connectionId === input.connectionId) connectionSnapshots += 1;
    }
    if (connectionSnapshots >= MAX_CONNECTION_SNAPSHOTS) {
      return failure(
        'operation_conflict',
        'Runtime Host connection transcript snapshot limit reached',
      );
    }

    const encoded: Buffer[] = [];
    let encodedBytes = 0;
    for (const message of input.messages) {
      const bytes = Buffer.from(JSON.stringify(message), 'utf8');
      encodedBytes += bytes.byteLength;
      if (encodedBytes > MAX_SNAPSHOT_BYTES) {
        return failure(
          'operation_unavailable',
          'Session transcript exceeds the live snapshot byte limit',
        );
      }
      encoded.push(bytes);
    }
    if (this.#retainedBytes() + encodedBytes > MAX_RETAINED_BYTES) {
      return failure('operation_conflict', 'Runtime Host transcript snapshot memory limit reached');
    }

    const snapshot: TranscriptSnapshot = {
      id: randomUUID(),
      connectionId: input.connectionId,
      subscriptionId: input.subscriptionId,
      sessionId: input.sessionId,
      messages: encoded,
      encodedBytes,
      lastAccessAt: this.#now(),
    };
    this.#snapshots.set(snapshot.id, snapshot);
    this.#scheduleCleanup();
    return this.#read(snapshot, { messageIndex: 0, byteOffset: 0 });
  }

  continue(input: {
    connectionId: string;
    subscriptionId: string;
    snapshotId: string;
    cursor: SessionTranscriptCursor;
  }): TranscriptSnapshotQueryOutcome {
    this.#pruneExpired();
    const snapshot = this.#snapshots.get(input.snapshotId);
    if (
      !snapshot ||
      snapshot.connectionId !== input.connectionId ||
      snapshot.subscriptionId !== input.subscriptionId
    ) {
      return { ok: true, result: { kind: 'snapshot_expired', snapshotId: input.snapshotId } };
    }
    snapshot.lastAccessAt = this.#now();
    this.#scheduleCleanup();
    return this.#read(snapshot, input.cursor);
  }

  deleteConnection(connectionId: string): void {
    this.#deleteWhere((snapshot) => snapshot.connectionId === connectionId);
  }

  deleteSubscription(subscriptionId: string): void {
    this.#deleteWhere((snapshot) => snapshot.subscriptionId === subscriptionId);
  }

  deleteSession(sessionId: string): void {
    this.#deleteWhere((snapshot) => snapshot.sessionId === sessionId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#snapshots.clear();
    if (this.#cleanupTimer) clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = undefined;
  }

  #read(
    snapshot: TranscriptSnapshot,
    cursor: SessionTranscriptCursor,
  ): TranscriptSnapshotQueryOutcome {
    if (snapshot.messages.length === 0) {
      if (cursor.messageIndex !== 0 || cursor.byteOffset !== 0) {
        return invalidCursor();
      }
      this.#delete(snapshot.id);
      return {
        ok: true,
        result: {
          kind: 'chunk',
          snapshotId: snapshot.id,
          sessionId: snapshot.sessionId,
          messageCount: 0,
          messageIndex: 0,
          byteOffset: 0,
          data: '',
          next: null,
        },
      };
    }

    const message = snapshot.messages[cursor.messageIndex];
    if (!message || cursor.byteOffset >= message.byteLength) return invalidCursor();
    const end = Math.min(
      message.byteLength,
      cursor.byteOffset + SESSION_TRANSCRIPT_CHUNK_MAX_BYTES,
    );
    const next =
      end < message.byteLength
        ? { messageIndex: cursor.messageIndex, byteOffset: end }
        : cursor.messageIndex + 1 < snapshot.messages.length
          ? { messageIndex: cursor.messageIndex + 1, byteOffset: 0 }
          : null;
    if (next === null) this.#delete(snapshot.id);
    return {
      ok: true,
      result: {
        kind: 'chunk',
        snapshotId: snapshot.id,
        sessionId: snapshot.sessionId,
        messageCount: snapshot.messages.length,
        messageIndex: cursor.messageIndex,
        byteOffset: cursor.byteOffset,
        data: message.subarray(cursor.byteOffset, end).toString('base64'),
        next,
      },
    };
  }

  #retainedBytes(): number {
    let total = 0;
    for (const snapshot of this.#snapshots.values()) total += snapshot.encodedBytes;
    return total;
  }

  #deleteWhere(predicate: (snapshot: TranscriptSnapshot) => boolean): void {
    for (const [id, snapshot] of this.#snapshots) {
      if (predicate(snapshot)) this.#snapshots.delete(id);
    }
    this.#scheduleCleanup();
  }

  #delete(snapshotId: string): void {
    this.#snapshots.delete(snapshotId);
    this.#scheduleCleanup();
  }

  #pruneExpired(): void {
    const now = this.#now();
    this.#deleteWhere((snapshot) => now - snapshot.lastAccessAt >= SNAPSHOT_IDLE_MS);
  }

  #scheduleCleanup(): void {
    if (this.#cleanupTimer) clearTimeout(this.#cleanupTimer);
    this.#cleanupTimer = undefined;
    if (this.#closed) return;
    let expiresAt = Number.POSITIVE_INFINITY;
    for (const snapshot of this.#snapshots.values()) {
      expiresAt = Math.min(expiresAt, snapshot.lastAccessAt + SNAPSHOT_IDLE_MS);
    }
    if (!Number.isFinite(expiresAt)) return;
    this.#cleanupTimer = setTimeout(
      () => {
        this.#cleanupTimer = undefined;
        this.#pruneExpired();
      },
      Math.max(1, expiresAt - this.#now()),
    );
    this.#cleanupTimer.unref();
  }
}

function failure(
  code: 'operation_conflict' | 'operation_unavailable',
  message: string,
): TranscriptSnapshotQueryOutcome {
  return { ok: false, error: { code, message } };
}

function invalidCursor(): TranscriptSnapshotQueryOutcome {
  return {
    ok: false,
    error: { code: 'invalid_request', message: 'Session transcript cursor is invalid' },
  };
}
