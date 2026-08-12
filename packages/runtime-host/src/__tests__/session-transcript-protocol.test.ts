import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSessionTranscriptBootstrap,
  decodeSessionTranscriptPage,
  decodeSessionTranscriptPageInput,
  encodeProtocolMessage,
  HOST_OPERATION_SPECS,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  RuntimeHostProtocolError,
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
} from '../protocol/index.js';

const input = {
  subscriptionId: 'subscription-1',
  source: 'durable' as const,
  direction: 'older' as const,
  throughSequence: 3,
  cursor: null,
  anchorSequence: 2,
  maxBytes: 1024,
};

const page = {
  kind: 'page' as const,
  sessionId: 'session-1',
  source: 'durable' as const,
  direction: 'older' as const,
  throughSequence: 3,
  rawBytes: 4,
  fragments: [
    {
      kind: 'durable' as const,
      sequence: 2,
      byteOffset: 0,
      totalBytes: 4,
      data: Buffer.from('test').toString('base64'),
    },
  ],
  nextCursor: 'opaque-cursor',
};

test('Session transcript protocol accepts bounded correlated pages and bootstraps', () => {
  assert.deepEqual(decodeSessionTranscriptPageInput(input), input);
  assert.deepEqual(decodeSessionTranscriptPage(page), page);
  assert.doesNotThrow(() =>
    HOST_OPERATION_SPECS['session.transcript.page'].assertOutputForInput?.(input, page),
  );

  const bootstrap = {
    throughSequence: 3,
    overlayMessageCount: 0,
    durable: { ...page, direction: 'older' as const },
    overlay: {
      kind: 'page' as const,
      sessionId: 'session-1',
      source: 'overlay' as const,
      direction: 'older' as const,
      throughSequence: 3,
      rawBytes: 0,
      fragments: [],
      nextCursor: null,
    },
  };
  assert.deepEqual(decodeSessionTranscriptBootstrap(bootstrap), bootstrap);
  assert.throws(
    () => decodeSessionTranscriptBootstrap({ ...bootstrap, overlayMessageCount: 4_097 }),
    isProtocolError,
  );
});

test('a maximum single-fragment continuation remains transport safe', () => {
  const data = Buffer.alloc(SESSION_TRANSCRIPT_PAGE_MAX_BYTES, 0x61);
  const result = {
    ...page,
    sessionId: 's'.repeat(128),
    rawBytes: data.byteLength,
    fragments: [
      {
        kind: 'durable' as const,
        sequence: 2,
        byteOffset: 1,
        totalBytes: data.byteLength + 1,
        data: data.toString('base64'),
      },
    ],
    nextCursor: 'c'.repeat(1_024),
  };
  assert.deepEqual(decodeSessionTranscriptPage(result), result);
  const encoded = encodeProtocolMessage({
    requestId: 'r'.repeat(128),
    operation: 'session.transcript.page',
    ok: true,
    result,
  });
  assert.ok(encoded.byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES);
});

test('Session transcript protocol rejects malformed and uncorrelated values', () => {
  assert.throws(
    () => decodeSessionTranscriptPageInput({ ...input, cursor: 'cursor', anchorSequence: 2 }),
    isProtocolError,
  );
  assert.throws(
    () =>
      decodeSessionTranscriptPage({
        ...page,
        fragments: [{ ...page.fragments[0], data: 'not base64' }],
      }),
    isProtocolError,
  );
  assert.throws(
    () =>
      HOST_OPERATION_SPECS['session.transcript.page'].assertOutputForInput?.(input, {
        ...page,
        throughSequence: 4,
      }),
    isProtocolError,
  );
  assert.throws(
    () =>
      decodeSessionTranscriptBootstrap({
        throughSequence: 3,
        overlayMessageCount: 0,
        durable: page,
        overlay: { ...page, source: 'overlay', throughSequence: 2 },
      }),
    isProtocolError,
  );
});

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
