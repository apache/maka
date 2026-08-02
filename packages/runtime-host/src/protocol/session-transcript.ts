import type { PermissionMode } from '@maka/core/permission';
import { requireCount, requireEntityId, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_TRANSCRIPT_CHUNK_MAX_BYTES = 24 * 1024;
export const SESSION_TRANSCRIPT_RESULT_MAX_BYTES = 48 * 1024;

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'persistence_failed',
  'internal_failure',
] as const;

export type SessionTranscriptQueryInput =
  | {
      readonly kind: 'start';
      readonly sessionId: string;
    }
  | {
      readonly kind: 'continue';
      readonly sessionId: string;
      readonly snapshotId: string;
      readonly revision: number;
      readonly boundaryRevision: number;
      readonly messageIndex: number;
      readonly byteOffset: number;
    };

export interface SessionExecutionBoundaryProjection {
  readonly kind: 'managed' | 'bypass' | 'external';
  readonly revision: number;
  readonly displayMode: PermissionMode | null;
}

export interface SessionTranscriptCursor {
  readonly messageIndex: number;
  readonly byteOffset: number;
}

export type SessionTranscriptQueryResult =
  | {
      readonly kind: 'chunk';
      readonly snapshotId: string;
      readonly revision: number;
      readonly boundary: SessionExecutionBoundaryProjection;
      readonly messageCount: number;
      readonly messageIndex: number;
      readonly byteOffset: number;
      readonly data: string;
      readonly next: SessionTranscriptCursor | null;
    }
  | {
      readonly kind: 'snapshot_expired';
      readonly snapshotId: string;
    }
  | {
      readonly kind: 'revision_changed';
      readonly expectedRevision: number;
      readonly actualRevision: number;
      readonly expectedBoundaryRevision: number;
      readonly actualBoundaryRevision: number;
    };

export const SESSION_TRANSCRIPT_OPERATION_SPECS = {
  'session.transcript.query': defineOperation<
    SessionTranscriptQueryInput,
    SessionTranscriptQueryResult,
    (typeof QUERY_ERRORS)[number]
  >({
    mode: 'query',
    availability: 'ready',
    errors: QUERY_ERRORS,
    decodeInput: decodeSessionTranscriptQueryInput,
    decodeOutput: decodeSessionTranscriptQueryResult,
    assertOutputForInput: assertSessionTranscriptOutput,
  }),
} as const;

export function decodeSessionTranscriptQueryInput(value: unknown): SessionTranscriptQueryInput {
  const input = requireRecord(value, 'Session transcript query input');
  if (input.kind === 'start') {
    const exact = requireExactRecord(input, 'Session transcript start input', [
      'kind',
      'sessionId',
    ]);
    return {
      kind: 'start',
      sessionId: requireEntityId(exact.sessionId, 'sessionId'),
    };
  }
  if (input.kind === 'continue') {
    const exact = requireExactRecord(input, 'Session transcript continuation input', [
      'kind',
      'sessionId',
      'snapshotId',
      'revision',
      'boundaryRevision',
      'messageIndex',
      'byteOffset',
    ]);
    return {
      kind: 'continue',
      sessionId: requireEntityId(exact.sessionId, 'sessionId'),
      snapshotId: requireEntityId(exact.snapshotId, 'Session transcript snapshotId'),
      revision: requirePositiveRevision(exact.revision, 'Session transcript revision'),
      boundaryRevision: requireCount(
        exact.boundaryRevision,
        'Session transcript boundary revision',
      ),
      messageIndex: requireCount(exact.messageIndex, 'Session transcript message index'),
      byteOffset: requireCount(exact.byteOffset, 'Session transcript byte offset'),
    };
  }
  throw invalidProtocolFrame('Invalid Session transcript query kind');
}

export function decodeSessionTranscriptQueryResult(value: unknown): SessionTranscriptQueryResult {
  const result = requireRecord(value, 'Session transcript query result');
  if (result.kind === 'snapshot_expired') {
    const exact = requireExactRecord(result, 'expired Session transcript snapshot', [
      'kind',
      'snapshotId',
    ]);
    return {
      kind: 'snapshot_expired',
      snapshotId: requireEntityId(exact.snapshotId, 'Session transcript snapshotId'),
    };
  }
  if (result.kind === 'revision_changed') {
    const exact = requireExactRecord(result, 'Session transcript revision change', [
      'kind',
      'expectedRevision',
      'actualRevision',
      'expectedBoundaryRevision',
      'actualBoundaryRevision',
    ]);
    return {
      kind: 'revision_changed',
      expectedRevision: requirePositiveRevision(
        exact.expectedRevision,
        'expected Session transcript revision',
      ),
      actualRevision: requirePositiveRevision(
        exact.actualRevision,
        'actual Session transcript revision',
      ),
      expectedBoundaryRevision: requireCount(
        exact.expectedBoundaryRevision,
        'expected Session transcript boundary revision',
      ),
      actualBoundaryRevision: requireCount(
        exact.actualBoundaryRevision,
        'actual Session transcript boundary revision',
      ),
    };
  }
  if (result.kind !== 'chunk') {
    throw invalidProtocolFrame('Invalid Session transcript query result kind');
  }
  const exact = requireExactRecord(result, 'Session transcript chunk', [
    'kind',
    'snapshotId',
    'revision',
    'boundary',
    'messageCount',
    'messageIndex',
    'byteOffset',
    'data',
    'next',
  ]);
  const messageCount = requireCount(exact.messageCount, 'Session transcript message count');
  const messageIndex = requireCount(exact.messageIndex, 'Session transcript message index');
  const byteOffset = requireCount(exact.byteOffset, 'Session transcript byte offset');
  const data = requireBase64Chunk(exact.data);
  const next = exact.next === null ? null : decodeSessionTranscriptCursor(exact.next);
  if (messageCount === 0) {
    if (messageIndex !== 0 || byteOffset !== 0 || data.length !== 0 || next !== null) {
      throw invalidProtocolFrame('Invalid empty Session transcript chunk');
    }
  } else if (messageIndex >= messageCount || data.length === 0) {
    throw invalidProtocolFrame('Invalid Session transcript chunk position');
  }
  const decoded: SessionTranscriptQueryResult = {
    kind: 'chunk',
    snapshotId: requireEntityId(exact.snapshotId, 'Session transcript snapshotId'),
    revision: requirePositiveRevision(exact.revision, 'Session transcript revision'),
    boundary: decodeBoundaryProjection(exact.boundary),
    messageCount,
    messageIndex,
    byteOffset,
    data,
    next,
  };
  if (Buffer.byteLength(JSON.stringify(decoded), 'utf8') > SESSION_TRANSCRIPT_RESULT_MAX_BYTES) {
    throw invalidProtocolFrame('Session transcript result exceeds byte limit');
  }
  return decoded;
}

function decodeBoundaryProjection(value: unknown): SessionExecutionBoundaryProjection {
  const boundary = requireExactRecord(value, 'Session execution boundary projection', [
    'kind',
    'revision',
    'displayMode',
  ]);
  if (boundary.kind !== 'managed' && boundary.kind !== 'bypass' && boundary.kind !== 'external') {
    throw invalidProtocolFrame('Invalid Session execution boundary kind');
  }
  const displayMode = boundary.displayMode;
  if (
    displayMode !== null &&
    displayMode !== 'ask' &&
    displayMode !== 'execute' &&
    displayMode !== 'explore' &&
    displayMode !== 'bypass'
  ) {
    throw invalidProtocolFrame('Invalid Session execution boundary display mode');
  }
  if ((boundary.kind === 'external') !== (displayMode === null)) {
    throw invalidProtocolFrame('Session execution boundary display mode does not match its kind');
  }
  return {
    kind: boundary.kind,
    revision: requireCount(boundary.revision, 'Session execution boundary revision'),
    displayMode,
  };
}

function decodeSessionTranscriptCursor(value: unknown): SessionTranscriptCursor {
  const cursor = requireExactRecord(value, 'Session transcript cursor', [
    'messageIndex',
    'byteOffset',
  ]);
  return {
    messageIndex: requireCount(cursor.messageIndex, 'Session transcript cursor message index'),
    byteOffset: requireCount(cursor.byteOffset, 'Session transcript cursor byte offset'),
  };
}

function requireBase64Chunk(value: unknown): string {
  if (typeof value !== 'string')
    throw invalidProtocolFrame('Invalid Session transcript chunk data');
  if (value.length === 0) return value;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw invalidProtocolFrame('Invalid Session transcript chunk encoding');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength > SESSION_TRANSCRIPT_CHUNK_MAX_BYTES || bytes.toString('base64') !== value) {
    throw invalidProtocolFrame('Invalid Session transcript chunk data');
  }
  return value;
}

function assertSessionTranscriptOutput(
  input: SessionTranscriptQueryInput,
  output: SessionTranscriptQueryResult,
): void {
  if (
    input.kind === 'continue' &&
    output.kind === 'snapshot_expired' &&
    output.snapshotId !== input.snapshotId
  ) {
    throw invalidProtocolFrame('Expired Session transcript snapshot does not match request');
  }
  if (
    input.kind === 'continue' &&
    output.kind === 'revision_changed' &&
    (output.expectedRevision !== input.revision ||
      output.expectedBoundaryRevision !== input.boundaryRevision)
  ) {
    throw invalidProtocolFrame('Session transcript revision change does not match request');
  }
  if (
    input.kind === 'continue' &&
    output.kind === 'chunk' &&
    (output.snapshotId !== input.snapshotId ||
      output.revision !== input.revision ||
      output.boundary.revision !== input.boundaryRevision ||
      output.messageIndex !== input.messageIndex ||
      output.byteOffset !== input.byteOffset)
  ) {
    throw invalidProtocolFrame('Session transcript chunk does not match request');
  }
}

function requirePositiveRevision(value: unknown, label: string): number {
  const revision = requireCount(value, label);
  if (revision < 1) throw invalidProtocolFrame(`Invalid ${label}`);
  return revision;
}
