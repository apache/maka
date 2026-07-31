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
        return success({
          kind: 'revision_changed',
          expectedRevision: input.revision,
          actualRevision: record.revision,
          expectedBoundaryRevision: input.boundaryRevision,
          actualBoundaryRevision: boundary.revision,
        });
      }
      const messages = await this.#options.store.readMessagesSnapshot(input.sessionId);
      const cursor: SessionTranscriptCursor =
        input.kind === 'start'
          ? { messageIndex: 0, byteOffset: 0 }
          : { messageIndex: input.messageIndex, byteOffset: input.byteOffset };
      if (
        cursor.messageIndex > messages.length ||
        (cursor.messageIndex === messages.length && cursor.byteOffset !== 0)
      ) {
        return invalidQuery('Session transcript cursor is invalid');
      }
      if (messages.length === 0) {
        return success({
          kind: 'chunk',
          revision: record.revision,
          boundary: projectSessionExecutionBoundary(boundary),
          messageCount: 0,
          messageIndex: 0,
          byteOffset: 0,
          data: '',
          next: null,
        });
      }
      if (cursor.messageIndex === messages.length) {
        return invalidQuery('Session transcript cursor is exhausted');
      }

      const encoded = Buffer.from(JSON.stringify(messages[cursor.messageIndex]), 'utf8');
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
          : cursor.messageIndex + 1 < messages.length
            ? { messageIndex: cursor.messageIndex + 1, byteOffset: 0 }
            : null;
      return success({
        kind: 'chunk',
        revision: record.revision,
        boundary: projectSessionExecutionBoundary(boundary),
        messageCount: messages.length,
        messageIndex: cursor.messageIndex,
        byteOffset: cursor.byteOffset,
        data: encoded.subarray(cursor.byteOffset, end).toString('base64'),
        next,
      });
    } catch (error) {
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
}

function success(
  result: SessionTranscriptQueryResult,
): OperationOutcome<'session.transcript.query'> {
  return { ok: true, result };
}

function invalidQuery(message: string): OperationOutcome<'session.transcript.query'> {
  return { ok: false, error: { code: 'invalid_request', message } };
}
