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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import { decodeArtifactQueryResult } from '../protocol/artifact.js';
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  decodeSessionTranscriptPage,
  SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
  type SessionTranscriptPage,
} from '../protocol/session-transcript.js';
import { createSessionTranscriptBootstrap } from '../server/session-transcript-pager.js';
import { transcriptReader } from './fixtures/session-transcript-reader.js';

function page(data: string, size: number, source: 'durable' | 'overlay'): SessionTranscriptPage {
  return {
    kind: 'page',
    sessionId: 'session-1',
    source,
    direction: 'older',
    throughSequence: 2,
    rawBytes: size,
    fragments: [
      {
        ...(source === 'durable'
          ? { kind: 'durable' as const, sequence: 2, payloadDigest: null }
          : { kind: 'overlay' as const, messageIndex: 2 }),
        byteOffset: 0,
        totalBytes: size,
        data,
      },
    ],
    rangeBoundarySequence: source === 'durable' ? 2 : null,
    protectedTurnSequence: source === 'durable' ? 2 : null,
    nextCursor: null,
  };
}

async function observeDecoding<T>(run: () => T | Promise<T>) {
  const original = Buffer.from;
  let bytes = 0;
  let calls = 0;
  Buffer.from = function (this: unknown, ...args: unknown[]) {
    const result: Buffer = Reflect.apply(original, this, args);
    if (typeof args[0] === 'string' && args[1] === 'base64') {
      bytes += result.byteLength;
      calls += 1;
    }
    return result;
  } as typeof Buffer.from;
  try {
    const value = await run();
    return { value, bytes, calls };
  } finally {
    Buffer.from = original;
  }
}

test('transcript length checks reuse validated Base64 without extra decoded buffers', async () => {
  let expectedBytes = 0;
  let expectedCalls = 0;
  const measured = await observeDecoding(() => {
    for (const source of ['durable', 'overlay'] as const) {
      for (const size of [
        1,
        2,
        3,
        4,
        31,
        32,
        33,
        32767,
        32768,
        32769,
        SESSION_TRANSCRIPT_PAGE_MAX_BYTES - 2,
        SESSION_TRANSCRIPT_PAGE_MAX_BYTES - 1,
        SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
      ]) {
        const bytes = Buffer.alloc(size, 0xdb);
        const input = page(bytes.toString('base64'), size, source);
        assert.deepEqual(decodeSessionTranscriptPage(input), input);
        // Keep the one canonical round-trip validation, including its pad-bit check.
        expectedBytes += size;
        expectedCalls += 1;
      }
    }
  });
  const invalid = [
    ['Zg', 1],
    ['Zg=', 1],
    ['Zg===', 1],
    ['Z g==', 1],
    ['Zg==\n', 1],
    ['-w==', 1],
    ['_w==', 1],
    ['!!!!', 1],
    ['Zh==', 1],
    ['Zm9=', 2],
    ['', 0],
  ] as const;
  for (const [data, size] of invalid) {
    assert.throws(
      () => decodeSessionTranscriptPage(page(data, size, 'durable')),
      RuntimeHostProtocolError,
    );
  }
  const valid = page('Zg==', 1, 'durable');
  assert.throws(
    () => decodeSessionTranscriptPage({ ...valid, rawBytes: 2 }),
    RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeSessionTranscriptPage({
        ...valid,
        fragments: [{ ...valid.fragments[0]!, byteOffset: 1 }],
      }),
    RuntimeHostProtocolError,
  );
  const tooLarge = SESSION_TRANSCRIPT_PAGE_MAX_BYTES + 1;
  assert.throws(
    () =>
      decodeSessionTranscriptPage(
        page(Buffer.alloc(tooLarge).toString('base64'), tooLarge, 'durable'),
      ),
    RuntimeHostProtocolError,
  );
  assert.equal(measured.calls, expectedCalls);
  assert.equal(measured.bytes, expectedBytes);
});

test('artifact preview and chunk bounds do not materialize decoded payloads', async () => {
  const measured = await observeDecoding(() => {
    for (const size of [0, 1, 2, 3, 31, 32, 33, 32766, 32767, 32768]) {
      const base64 = Buffer.alloc(size, 0xfb).toString('base64');
      const binary = {
        kind: 'binary',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        preview: { ok: true, base64, mimeType: 'image/png' },
      };
      assert.deepEqual(decodeArtifactQueryResult(binary), binary);
      for (const offset of [0, 17]) {
        const chunk = {
          kind: 'chunk',
          sessionId: 'session-1',
          artifactId: 'artifact-1',
          offset,
          totalBytes: offset + size,
          chunkBase64: base64,
          nextOffset: null,
        };
        assert.deepEqual(decodeArtifactQueryResult(chunk), chunk);
        assert.throws(
          () => decodeArtifactQueryResult({ ...chunk, nextOffset: offset + size }),
          RuntimeHostProtocolError,
        );
        if (size > 0) {
          assert.deepEqual(
            decodeArtifactQueryResult({
              ...chunk,
              totalBytes: offset + size + 1,
              nextOffset: offset + size,
            }),
            { ...chunk, totalBytes: offset + size + 1, nextOffset: offset + size },
          );
          assert.throws(
            () => decodeArtifactQueryResult({ ...chunk, totalBytes: offset + size - 1 }),
            RuntimeHostProtocolError,
          );
        }
      }
    }
    // Preserve the existing artifact grammar: unlike transcript fragments it accepts nonzero pad bits.
    for (const data of ['Zh==', 'Zm9=']) {
      assert.doesNotThrow(() =>
        decodeArtifactQueryResult({
          kind: 'chunk',
          sessionId: 'session-1',
          artifactId: 'artifact-1',
          offset: 0,
          totalBytes: data === 'Zh==' ? 1 : 2,
          chunkBase64: data,
          nextOffset: null,
        }),
      );
    }
    for (const base64 of [
      'Zg',
      'Zg=',
      'Zg===',
      'Z g==',
      'Zg==\n',
      '-w==',
      '_w==',
      '!!!!',
      Buffer.alloc(32769).toString('base64'),
    ]) {
      assert.throws(
        () =>
          decodeArtifactQueryResult({
            kind: 'binary',
            sessionId: 'session-1',
            artifactId: 'artifact-1',
            preview: { ok: true, base64, mimeType: 'image/png' },
          }),
        RuntimeHostProtocolError,
      );
      assert.throws(
        () =>
          decodeArtifactQueryResult({
            kind: 'chunk',
            sessionId: 'session-1',
            artifactId: 'artifact-1',
            offset: 0,
            totalBytes: 32769,
            chunkBase64: base64,
            nextOffset: null,
          }),
        RuntimeHostProtocolError,
      );
    }
  });
  assert.equal(measured.calls, 0);
  assert.equal(measured.bytes, 0);
});

test('pager far-edge trimming counts generated Base64 without decoding retained fragments', async () => {
  const durable: StoredMessage[] = Array.from({ length: 257 }, (_, index) => ({
    type: 'assistant',
    id: `message-${index}`,
    turnId: index < 3 ? 'turn-far-edge' : `turn-${index}`,
    ts: index + 1,
    modelId: 'model-1',
    text: `message-${index} 中文🦊`,
    thinking: { text: `thinking-${index}`, signature: '' },
  }));
  const measured = await observeDecoding(() =>
    createSessionTranscriptBootstrap({
      reader: transcriptReader(durable),
      sessionId: 'session-1',
      subscriptionId: 'subscription-1',
      throughSequence: 256,
      rootTurn: null,
      activeAssistantStreams: [],
      maxBytes: SESSION_TRANSCRIPT_PAGE_MAX_BYTES,
      projection: 'owner',
    }),
  );
  const result = measured.value.bootstrap.durable;
  assert.deepEqual(
    result.fragments.map((fragment) => fragment.kind === 'durable' && fragment.sequence),
    Array.from({ length: 254 }, (_, index) => 256 - index),
  );
  const decoded = result.fragments.map((fragment) => Buffer.from(fragment.data, 'base64'));
  assert.equal(
    result.rawBytes,
    decoded.reduce((sum, buffer) => sum + buffer.byteLength, 0),
  );
  assert.deepEqual(
    decoded.map((buffer) => JSON.parse(buffer.toString('utf8'))),
    durable.slice(3).reverse(),
  );
  assert.equal(result.rangeBoundarySequence, 3);
  assert.equal(result.protectedTurnSequence, 256);
  assert.ok(result.nextCursor);
  assert.equal(measured.calls, 0);
  assert.equal(measured.bytes, 0);
});
