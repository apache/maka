import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSessionTranscriptQueryInput,
  decodeSessionTranscriptQueryResult,
  HOST_OPERATION_SPECS,
  RuntimeHostProtocolError,
  SESSION_TRANSCRIPT_CHUNK_MAX_BYTES,
} from '../protocol/index.js';

test('Session transcript protocol keeps exact bounded chunk cursors', () => {
  assert.deepEqual(
    decodeSessionTranscriptQueryInput({ kind: 'start', subscriptionId: 'subscription-1' }),
    { kind: 'start', subscriptionId: 'subscription-1' },
  );
  const input = {
    kind: 'continue' as const,
    subscriptionId: 'subscription-1',
    snapshotId: 'snapshot-1',
    messageIndex: 2,
    byteOffset: 3,
  };
  assert.deepEqual(decodeSessionTranscriptQueryInput(input), input);
  const output = {
    kind: 'chunk' as const,
    snapshotId: 'snapshot-1',
    sessionId: 'session-1',
    messageCount: 4,
    messageIndex: 2,
    byteOffset: 3,
    data: Buffer.alloc(SESSION_TRANSCRIPT_CHUNK_MAX_BYTES).toString('base64'),
    next: { messageIndex: 3, byteOffset: 0 },
  };
  assert.deepEqual(decodeSessionTranscriptQueryResult(output), output);
  assert.doesNotThrow(() =>
    HOST_OPERATION_SPECS['session.transcript.query'].assertOutputForInput?.(input, output),
  );
});

test('Session transcript protocol rejects open, malformed, and uncorrelated values', () => {
  assert.throws(
    () =>
      decodeSessionTranscriptQueryInput({
        kind: 'start',
        subscriptionId: 'subscription-1',
        sessionId: 'session-1',
      }),
    isProtocolError,
  );
  assert.throws(
    () =>
      decodeSessionTranscriptQueryResult({
        kind: 'chunk',
        snapshotId: 'snapshot-1',
        sessionId: 'session-1',
        messageCount: 1,
        messageIndex: 0,
        byteOffset: 0,
        data: 'not base64',
        next: null,
      }),
    isProtocolError,
  );
  assert.throws(
    () =>
      HOST_OPERATION_SPECS['session.transcript.query'].assertOutputForInput?.(
        {
          kind: 'continue',
          subscriptionId: 'subscription-1',
          snapshotId: 'snapshot-1',
          messageIndex: 0,
          byteOffset: 4,
        },
        {
          kind: 'snapshot_expired',
          snapshotId: 'different-snapshot',
        },
      ),
    isProtocolError,
  );
});

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
