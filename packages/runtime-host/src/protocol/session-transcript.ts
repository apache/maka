import { requireCount, requireEntityId, requireExactRecord, requireRecord } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';

export const SESSION_TRANSCRIPT_CHUNK_MAX_BYTES = 24 * 1024;
export const SESSION_TRANSCRIPT_RESULT_MAX_BYTES = 48 * 1024;

export interface SessionTranscriptCursor {
  messageIndex: number;
  byteOffset: number;
}

export type SessionTranscriptQueryInput =
  | { kind: 'start'; subscriptionId: string }
  | {
      kind: 'continue';
      subscriptionId: string;
      snapshotId: string;
      messageIndex: number;
      byteOffset: number;
    };

export type SessionTranscriptQueryResult =
  | {
      kind: 'chunk';
      snapshotId: string;
      sessionId: string;
      messageCount: number;
      messageIndex: number;
      byteOffset: number;
      data: string;
      next: SessionTranscriptCursor | null;
    }
  | { kind: 'snapshot_expired'; snapshotId: string };

const QUERY_ERRORS = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'invalid_request',
  'not_found',
  'operation_conflict',
  'persistence_failed',
  'internal_failure',
] as const;

export const SESSION_TRANSCRIPT_OPERATION_SPECS = {
  'session.transcript.query': defineOperation({
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
      'subscriptionId',
    ]);
    return {
      kind: 'start',
      subscriptionId: requireEntityId(exact.subscriptionId, 'subscriptionId'),
    };
  }
  if (input.kind === 'continue') {
    const exact = requireExactRecord(input, 'Session transcript continuation input', [
      'kind',
      'subscriptionId',
      'snapshotId',
      'messageIndex',
      'byteOffset',
    ]);
    return {
      kind: 'continue',
      subscriptionId: requireEntityId(exact.subscriptionId, 'subscriptionId'),
      snapshotId: requireEntityId(exact.snapshotId, 'Session transcript snapshotId'),
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
  if (result.kind !== 'chunk') {
    throw invalidProtocolFrame('Invalid Session transcript query result kind');
  }
  const exact = requireExactRecord(result, 'Session transcript chunk', [
    'kind',
    'snapshotId',
    'sessionId',
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
    sessionId: requireEntityId(exact.sessionId, 'sessionId'),
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
  if (input.kind !== 'continue') return;
  if (output.kind === 'snapshot_expired') {
    if (output.snapshotId !== input.snapshotId) {
      throw invalidProtocolFrame('Expired Session transcript snapshot does not match request');
    }
    return;
  }
  if (
    output.snapshotId !== input.snapshotId ||
    output.messageIndex !== input.messageIndex ||
    output.byteOffset !== input.byteOffset
  ) {
    throw invalidProtocolFrame('Session transcript chunk does not match request');
  }
}
