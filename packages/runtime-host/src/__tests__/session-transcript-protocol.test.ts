import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  HOST_OPERATION_SPECS,
  SESSION_TRANSCRIPT_CHUNK_MAX_BYTES,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

describe('Session transcript protocol', () => {
  test('declares one revision-pinned ready query', () => {
    assert.deepEqual(
      Object.keys(HOST_OPERATION_SPECS).filter((key) => key.startsWith('session.transcript.')),
      ['session.transcript.query'],
    );
    assert.equal(HOST_OPERATION_SPECS['session.transcript.query'].mode, 'query');
    assert.equal(HOST_OPERATION_SPECS['session.transcript.query'].availability, 'ready');
    assert.doesNotThrow(() => request({ kind: 'start', sessionId: 'session-1' }));
    assert.doesNotThrow(() =>
      request({
        kind: 'continue',
        sessionId: 'session-1',
        snapshotId: 'snapshot-1',
        revision: 2,
        boundaryRevision: 4,
        messageIndex: 1,
        byteOffset: 1024,
      }),
    );
  });

  test('preserves bounded chunks and an authoritative boundary projection', () => {
    const data = Buffer.alloc(SESSION_TRANSCRIPT_CHUNK_MAX_BYTES, 1).toString('base64');
    const decoded = response({
      kind: 'chunk',
      snapshotId: 'snapshot-1',
      revision: 2,
      boundary: { kind: 'managed', revision: 4, displayMode: 'explore' },
      messageCount: 3,
      messageIndex: 1,
      byteOffset: 0,
      data,
      next: { messageIndex: 1, byteOffset: SESSION_TRANSCRIPT_CHUNK_MAX_BYTES },
    });
    assert.equal('ok' in decoded && decoded.ok, true);

    assert.doesNotThrow(() =>
      response({
        kind: 'chunk',
        snapshotId: 'snapshot-1',
        revision: 1,
        boundary: { kind: 'external', revision: 0, displayMode: null },
        messageCount: 0,
        messageIndex: 0,
        byteOffset: 0,
        data: '',
        next: null,
      }),
    );
  });

  test('rejects widened cursors, invalid base64, and inconsistent boundary display', () => {
    assert.throws(
      () => request({ kind: 'start', sessionId: 'session-1', cursor: 0 }),
      isInvalidFrame,
    );
    for (const result of [
      {
        kind: 'chunk',
        snapshotId: 'snapshot-1',
        revision: 1,
        boundary: { kind: 'managed', revision: 0, displayMode: null },
        messageCount: 1,
        messageIndex: 0,
        byteOffset: 0,
        data: 'eA==',
        next: null,
      },
      {
        kind: 'chunk',
        snapshotId: 'snapshot-1',
        revision: 1,
        boundary: { kind: 'bypass', revision: 0, displayMode: 'bypass' },
        messageCount: 1,
        messageIndex: 0,
        byteOffset: 0,
        data: 'not base64',
        next: null,
      },
      {
        kind: 'chunk',
        snapshotId: 'snapshot-1',
        revision: 1,
        boundary: { kind: 'bypass', revision: 0, displayMode: 'bypass' },
        messageCount: 0,
        messageIndex: 0,
        byteOffset: 0,
        data: 'eA==',
        next: null,
      },
    ]) {
      assert.throws(() => response(result), isInvalidFrame);
    }
  });

  test('correlates continuations and revision conflicts with their request', () => {
    const input = {
      kind: 'continue' as const,
      sessionId: 'session-1',
      snapshotId: 'snapshot-1',
      revision: 3,
      boundaryRevision: 4,
      messageIndex: 2,
      byteOffset: 8,
    };
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['session.transcript.query'].assertOutputForInput?.(input, {
          kind: 'revision_changed',
          expectedRevision: 2,
          actualRevision: 4,
          expectedBoundaryRevision: 4,
          actualBoundaryRevision: 5,
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['session.transcript.query'].assertOutputForInput?.(input, {
          kind: 'revision_changed',
          expectedRevision: 3,
          actualRevision: 3,
          expectedBoundaryRevision: 3,
          actualBoundaryRevision: 5,
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['session.transcript.query'].assertOutputForInput?.(input, {
          kind: 'chunk',
          snapshotId: 'snapshot-1',
          revision: 3,
          boundary: { kind: 'bypass', revision: 4, displayMode: 'bypass' },
          messageCount: 3,
          messageIndex: 2,
          byteOffset: 9,
          data: 'eA==',
          next: null,
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['session.transcript.query'].assertOutputForInput?.(input, {
          kind: 'snapshot_expired',
          snapshotId: 'snapshot-2',
        }),
      isInvalidFrame,
    );
    assert.doesNotThrow(() =>
      HOST_OPERATION_SPECS['session.transcript.query'].assertOutputForInput?.(input, {
        kind: 'snapshot_expired',
        snapshotId: 'snapshot-1',
      }),
    );
  });
});

function request(input: unknown): unknown {
  return decodeClientFrame({
    requestId: 'request-1',
    operation: 'session.transcript.query',
    input,
  });
}

function response(result: unknown) {
  return decodeHostFrame({
    requestId: 'request-1',
    operation: 'session.transcript.query',
    ok: true,
    result,
  });
}

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
