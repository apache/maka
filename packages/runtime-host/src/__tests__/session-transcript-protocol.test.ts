import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSessionTranscriptBootstrap,
  decodeSessionTranscriptPage,
  decodeSessionTranscriptPageInput,
  HOST_OPERATION_SPECS,
  RuntimeHostProtocolError,
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
        durable: page,
        overlay: { ...page, source: 'overlay', throughSequence: 2 },
      }),
    isProtocolError,
  );
});

function isProtocolError(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}
