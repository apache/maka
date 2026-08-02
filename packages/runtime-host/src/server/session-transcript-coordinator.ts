import { randomUUID } from 'node:crypto';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  decodeExecutionBoundary,
  executionBoundaryDisplayMode,
  type ExecutionBoundary,
} from '@maka/core/sandbox-boundary';
import {
  SESSION_TRANSCRIPT_CHUNK_MAX_BYTES,
  type OperationOutcome,
  type SessionExecutionBoundaryProjection,
  type SessionTranscriptCursor,
  type SessionTranscriptQueryInput,
  type SessionTranscriptQueryResult,
} from '../protocol/index.js';
import type { SessionTranscriptOperationHandlerMap } from './operation-dispatcher.js';
import { SessionAdmissionGate } from './session-admission-gate.js';

type SessionTranscriptStore = Pick<
  ExecutionStoresWriter<'interactive'>['sessionStore'],
  'readExecutionBoundary' | 'readHeaderRecordSnapshot' | 'readMessagesSnapshot'
>;

const MAX_TRANSCRIPT_SNAPSHOTS = 8;
export const MAX_TRANSCRIPT_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_SNAPSHOT_IDLE_MS = 60_000;

interface TranscriptSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly revision: number;
  readonly boundaryRevision: number;
  readonly messages: readonly Buffer[];
  readonly encodedBytes: number;
  lastAccessAt: number;
}

export interface HostSessionTranscriptCoordinatorOptions {
  readonly store: SessionTranscriptStore;
  readonly admission: SessionAdmissionGate;
}

function projectSessionExecutionBoundary(
  boundary: ExecutionBoundary,
): SessionExecutionBoundaryProjection {
  const decoded = decodeExecutionBoundary(boundary);
  return {
    kind: decoded.kind,
    revision: decoded.revision,
    displayMode: executionBoundaryDisplayMode(decoded) ?? null,
  };
}

/** Host-owned, revision-pinned projection of the durable Session transcript. */
export class HostSessionTranscriptCoordinator {
  readonly handlers: SessionTranscriptOperationHandlerMap = {
    'session.transcript.query': (input) =>
      this.#options.admission.run(input.sessionId, () => this.#query(input)),
  };

  readonly #options: HostSessionTranscriptCoordinatorOptions;
  readonly #snapshots = new Map<string, TranscriptSnapshot>();
  #snapshotCleanupTimer: NodeJS.Timeout | undefined;

  constructor(options: HostSessionTranscriptCoordinatorOptions) {
    this.#options = options;
  }

  async #query(
    input: SessionTranscriptQueryInput,
  ): Promise<OperationOutcome<'session.transcript.query'>> {
    try {
      const [record, boundary] = await Promise.all([
        this.#options.store.readHeaderRecordSnapshot(input.sessionId),
        this.#options.store.readExecutionBoundary(input.sessionId),
      ]);
      if (
        input.kind === 'continue' &&
        (record.revision !== input.revision || boundary.revision !== input.boundaryRevision)
      ) {
        this.#snapshots.delete(input.snapshotId);
        return success({
          kind: 'revision_changed',
          expectedRevision: input.revision,
          actualRevision: record.revision,
          expectedBoundaryRevision: input.boundaryRevision,
          actualBoundaryRevision: boundary.revision,
        });
      }
      let snapshot: TranscriptSnapshot;
      if (input.kind === 'start') {
        const messages = await this.#options.store.readMessagesSnapshot(input.sessionId);
        const encodedMessages: Buffer[] = [];
        let encodedBytes = 0;
        for (const message of messages) {
          const encoded = Buffer.from(JSON.stringify(message), 'utf8');
          encodedBytes += encoded.byteLength;
          if (encodedBytes > MAX_TRANSCRIPT_SNAPSHOT_BYTES) {
            return {
              ok: false,
              error: {
                code: 'operation_unavailable',
                message: 'Session transcript exceeds the live snapshot byte limit',
              },
            };
          }
          encodedMessages.push(encoded);
        }
        snapshot = {
          id: randomUUID(),
          sessionId: input.sessionId,
          revision: record.revision,
          boundaryRevision: boundary.revision,
          messages: encodedMessages,
          encodedBytes,
          lastAccessAt: Date.now(),
        };
        this.#retainSnapshot(snapshot);
      } else {
        const retained = this.#snapshots.get(input.snapshotId);
        if (
          !retained ||
          retained.sessionId !== input.sessionId ||
          retained.revision !== input.revision ||
          retained.boundaryRevision !== input.boundaryRevision
        ) {
          return success({ kind: 'snapshot_expired', snapshotId: input.snapshotId });
        }
        retained.lastAccessAt = Date.now();
        snapshot = retained;
      }
      const cursor: SessionTranscriptCursor =
        input.kind === 'start'
          ? { messageIndex: 0, byteOffset: 0 }
          : { messageIndex: input.messageIndex, byteOffset: input.byteOffset };
      if (
        cursor.messageIndex > snapshot.messages.length ||
        (cursor.messageIndex === snapshot.messages.length && cursor.byteOffset !== 0)
      ) {
        return invalidQuery('Session transcript cursor is invalid');
      }
      if (snapshot.messages.length === 0) {
        this.#snapshots.delete(snapshot.id);
        return success({
          kind: 'chunk',
          snapshotId: snapshot.id,
          revision: record.revision,
          boundary: projectSessionExecutionBoundary(boundary),
          messageCount: 0,
          messageIndex: 0,
          byteOffset: 0,
          data: '',
          next: null,
        });
      }
      if (cursor.messageIndex === snapshot.messages.length) {
        return invalidQuery('Session transcript cursor is exhausted');
      }

      const encoded = snapshot.messages[cursor.messageIndex];
      if (!encoded) return invalidQuery('Session transcript cursor is invalid');
      if (cursor.byteOffset >= encoded.byteLength) {
        return invalidQuery('Session transcript cursor is invalid');
      }
      const end = Math.min(
        encoded.byteLength,
        cursor.byteOffset + SESSION_TRANSCRIPT_CHUNK_MAX_BYTES,
      );
      const next =
        end < encoded.byteLength
          ? { messageIndex: cursor.messageIndex, byteOffset: end }
          : cursor.messageIndex + 1 < snapshot.messages.length
            ? { messageIndex: cursor.messageIndex + 1, byteOffset: 0 }
            : null;
      if (next === null) this.#snapshots.delete(snapshot.id);
      return success({
        kind: 'chunk',
        snapshotId: snapshot.id,
        revision: record.revision,
        boundary: projectSessionExecutionBoundary(boundary),
        messageCount: snapshot.messages.length,
        messageIndex: cursor.messageIndex,
        byteOffset: cursor.byteOffset,
        data: encoded.subarray(cursor.byteOffset, end).toString('base64'),
        next,
      });
    } catch (error) {
      if (input.kind === 'continue') this.#snapshots.delete(input.snapshotId);
      if (isSessionNotFoundError(error)) {
        return {
          ok: false,
          error: { code: 'not_found', message: 'Session does not exist' },
        };
      }
      return {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'Session transcript is unavailable',
        },
      };
    }
  }

  #retainSnapshot(snapshot: TranscriptSnapshot): void {
    this.#pruneExpiredSnapshots();
    this.#snapshots.set(snapshot.id, snapshot);
    while (
      this.#snapshots.size > MAX_TRANSCRIPT_SNAPSHOTS ||
      this.#retainedSnapshotBytes() > MAX_TRANSCRIPT_SNAPSHOT_BYTES
    ) {
      const oldest = [...this.#snapshots.values()]
        .filter((candidate) => candidate.id !== snapshot.id)
        .sort((left, right) => left.lastAccessAt - right.lastAccessAt)[0];
      if (!oldest) break;
      this.#snapshots.delete(oldest.id);
    }
    this.#scheduleSnapshotCleanup();
  }

  #retainedSnapshotBytes(): number {
    let total = 0;
    for (const snapshot of this.#snapshots.values()) total += snapshot.encodedBytes;
    return total;
  }

  #pruneExpiredSnapshots(): void {
    const now = Date.now();
    for (const [id, retained] of this.#snapshots) {
      if (now - retained.lastAccessAt >= TRANSCRIPT_SNAPSHOT_IDLE_MS) this.#snapshots.delete(id);
    }
  }

  #scheduleSnapshotCleanup(): void {
    if (this.#snapshotCleanupTimer) clearTimeout(this.#snapshotCleanupTimer);
    this.#snapshotCleanupTimer = undefined;
    let expiresAt = Number.POSITIVE_INFINITY;
    for (const snapshot of this.#snapshots.values()) {
      expiresAt = Math.min(expiresAt, snapshot.lastAccessAt + TRANSCRIPT_SNAPSHOT_IDLE_MS);
    }
    if (!Number.isFinite(expiresAt)) return;
    this.#snapshotCleanupTimer = setTimeout(
      () => {
        this.#snapshotCleanupTimer = undefined;
        this.#pruneExpiredSnapshots();
        this.#scheduleSnapshotCleanup();
      },
      Math.max(0, expiresAt - Date.now()),
    );
    this.#snapshotCleanupTimer.unref();
  }
}

function success(
  result: SessionTranscriptQueryResult,
): OperationOutcome<'session.transcript.query'> {
  return { ok: true, result };
}

function invalidQuery(message: string): OperationOutcome<'session.transcript.query'> {
  return { ok: false, error: { code: 'invalid_request', message } };
}
