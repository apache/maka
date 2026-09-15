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
import { test } from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import {
  FramedByteStreamTransport,
  type RuntimeHostByteStream,
} from '../transport/framed-byte-stream-transport.js';

test('fragmented Host frames require linear byte copying and delimiter scanning', async (t) => {
  const stream = new TestByteStream();
  const transport = new FramedByteStreamTransport(stream);
  const expected = { payload: 'x'.repeat(192 * 1024) };
  const wire = Buffer.from(`${JSON.stringify(expected)}\n`);
  let copiedBytes = 0;
  let searchedBytes = 0;
  const concat = Buffer.concat;
  const copy = Buffer.prototype.copy;
  const indexOf: (
    this: Buffer,
    value: string | number | Uint8Array,
    offset?: number | BufferEncoding,
    encoding?: BufferEncoding,
  ) => number = Buffer.prototype.indexOf;
  const concatMock = t.mock.method(
    Buffer,
    'concat',
    (...[list, totalLength]: Parameters<typeof Buffer.concat>) => {
      copiedBytes += totalLength ?? list.reduce((sum, part) => sum + part.byteLength, 0);
      return concat(list, totalLength);
    },
  );
  const copyMock = t.mock.method(
    Buffer.prototype,
    'copy',
    function (this: Buffer, ...[target, targetStart, start, end]: Parameters<Buffer['copy']>) {
      const written = copy.call(this, target, targetStart, start, end);
      copiedBytes += written;
      return written;
    },
  );
  const indexMock = t.mock.method(
    Buffer.prototype,
    'indexOf',
    function (this: Buffer, ...[value, offset, encoding]: Parameters<typeof indexOf>) {
      if (value === 0x0a)
        searchedBytes += this.byteLength - (typeof offset === 'number' ? offset : 0);
      return indexOf.call(this, value, offset, encoding);
    },
  );
  try {
    for (let offset = 0; offset < wire.byteLength; offset += 256) {
      stream.data(wire.subarray(offset, offset + 256));
    }
  } finally {
    concatMock.mock.restore();
    copyMock.mock.restore();
    indexMock.mock.restore();
  }
  try {
    assert.deepEqual(await transport.read(1_000), expected);
    assert.ok(
      copiedBytes < wire.byteLength * 8,
      `copied ${copiedBytes} bytes for ${wire.byteLength} input bytes`,
    );
    assert.ok(
      searchedBytes < wire.byteLength * 8,
      `searched ${searchedBytes} bytes for ${wire.byteLength} input bytes`,
    );
  } finally {
    transport.abort();
    await transport.closed;
  }
});

test('retains split UTF-8 when the producer reuses its buffer and a frame shares its tail', async () => {
  const stream = new TestByteStream();
  const transport = new FramedByteStreamTransport(stream);
  const expected = { text: '客户端🙂'.repeat(40) };
  const first = Buffer.from(`${JSON.stringify(expected)}\r\n`);
  const next = Buffer.from(`${JSON.stringify({ next: true })}\n`);
  const wire = Buffer.concat([first, next]);
  const reusable = Buffer.alloc(7);
  try {
    for (let offset = 0; offset < wire.byteLength; offset += reusable.byteLength) {
      const size = wire.copy(reusable, 0, offset, offset + reusable.byteLength);
      stream.data(reusable.subarray(0, size));
      reusable.fill(0);
    }
    stream.end();
    assert.deepEqual(await transport.read(1_000), expected);
    assert.deepEqual(await transport.read(1_000), { next: true });
    await assert.rejects(transport.read(1_000), { code: 'read_eof' });
  } finally {
    transport.abort();
    await transport.closed;
  }
});

class TestByteStream implements RuntimeHostByteStream {
  readonly completion = deferred<void>();
  readonly closed = this.completion.promise;
  data: (chunk: Buffer) => void = () => {};
  end: () => void = () => {};
  onData(listener: (chunk: Buffer) => void): void {
    this.data = listener;
  }
  onEnd(listener: () => void): void {
    this.end = listener;
  }
  onError(_listener: (error: Error) => void): void {}
  async write(_chunk: Buffer): Promise<void> {}
  closeAfterFlush(): void {
    this.completion.resolve();
  }
  abort(): void {
    this.completion.resolve();
  }
  pause(): void {}
  resume(): void {}
}
