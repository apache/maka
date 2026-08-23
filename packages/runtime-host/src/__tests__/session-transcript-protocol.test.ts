/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSessionTranscriptBootstrap,
  decodeSessionTranscriptPage,
  decodeSessionTranscriptPageInput,
  encodeProtocolMessage,
  HOST_OPERATION_SPECS,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
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
const payloadDigest = `sha256:${'a'.repeat(64)}` as const;

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
      payloadDigest: null,
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
  const release = { subscriptionId: 'subscription-1' };
  assert.deepEqual(
    HOST_OPERATION_SPECS['session.transcript.overlay.release'].decodeInput(release),
    release,
  );
  assert.deepEqual(
    HOST_OPERATION_SPECS['session.transcript.overlay.release'].decodeOutput(release),
    release,
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
        payloadDigest,
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

test('a maximum multi-message page remains transport safe', () => {
  const fragmentBytes = SESSION_TRANSCRIPT_PAGE_MAX_BYTES / 256;
  const result = {
    ...page,
    sessionId: 's'.repeat(128),
    direction: 'newer' as const,
    throughSequence: Number.MAX_SAFE_INTEGER,
    rawBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
    fragments: Array.from({ length: 256 }, (_, sequence) => ({
      kind: 'durable' as const,
      sequence,
      byteOffset: 0,
      totalBytes: fragmentBytes,
      payloadDigest,
      data: Buffer.alloc(fragmentBytes, 0x61).toString('base64'),
    })),
    nextCursor: 'c'.repeat(1_024),
  };
  assert.deepEqual(decodeSessionTranscriptPage(result), result);
  assert.ok(
    encodeProtocolMessage({
      requestId: 'r'.repeat(128),
      operation: 'session.transcript.page',
      ok: true,
      result,
    }).byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES,
  );
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
