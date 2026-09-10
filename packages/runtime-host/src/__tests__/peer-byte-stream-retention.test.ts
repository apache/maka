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
import { spawnSync } from 'node:child_process';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  readRuntimeHostPeerAuthentication,
  RuntimeHostPeerByteStream,
  type RuntimeHostPeerNativeStream,
} from '../transport/peer-native.js';
import { FramedByteStreamTransport } from '../transport/framed-byte-stream-transport.js';
import { ResumablePeerStream } from '../transport/resumable-peer-stream.js';

class NativeInput implements RuntimeHostPeerNativeStream {
  readonly peerId = 'peer';
  readonly chunks: Buffer[] = [];
  pending?: (chunk: Buffer | null) => void;
  reads = 0;
  ended = false;
  read(): Promise<Buffer | null> {
    this.reads++;
    if (this.chunks.length) return Promise.resolve(this.chunks.shift()!);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }
  push(chunk: Buffer) {
    if (this.pending) {
      const resolve = this.pending;
      this.pending = undefined;
      resolve(chunk);
    } else this.chunks.push(chunk);
  }
  async write() {}
  async close() {
    this.abort();
  }
  abort() {
    this.ended = true;
    this.chunks.length = 0;
    this.pending?.(null);
    this.pending = undefined;
  }
}

test('peer byte streams release consumed initial and current chunks while remaining open', async () => {
  if (!global.gc) {
    assert.notEqual(process.env.MAKA_PEER_BYTE_GC_CHILD, '1');
    const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, MAKA_PEER_BYTE_GC_CHILD: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return;
  }
  const streams: RuntimeHostPeerByteStream[] = [];
  const framed: FramedByteStreamTransport[] = [];
  const initial: Array<WeakRef<ArrayBufferLike>> = [];
  const current: Array<WeakRef<ArrayBufferLike>> = [];
  async function collect() {
    for (let i = 0; i < 10; i++) {
      await tick();
      global.gc!();
    }
  }
  function push(native: NativeInput, value: unknown) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    assert.ok(bytes.length >= Buffer.poolSize >>> 1, 'observe an unpooled backing');
    assert.ok(bytes.length <= 65536, 'within the native read limit');
    current.push(new WeakRef(bytes.buffer));
    native.push(bytes);
  }
  async function mount(withPreface: boolean) {
    const native = new NativeInput();
    let initialData: Buffer = Buffer.alloc(0);
    const first = { first: '🦊'.repeat(15000) };
    if (withPreface) {
      native.push(Buffer.from('{"v":1,"credential":"valid"}\n' + JSON.stringify(first) + '\n'));
      const auth = await readRuntimeHostPeerAuthentication(native);
      assert.equal(auth.credential, 'valid');
      initialData = auth.remainder;
      assert.ok(initialData.length >= Buffer.poolSize >>> 1);
      initial.push(new WeakRef(initialData.buffer));
    }
    const stream = new RuntimeHostPeerByteStream(native, initialData);
    const transport = new FramedByteStreamTransport(stream);
    streams.push(stream);
    framed.push(transport);
    if (withPreface) assert.deepEqual(await transport.read(1000), first);
    else await tick();
    return { stream, transport, native };
  }
  try {
    const legacy = await mount(true);
    const ordinary = await mount(false);
    for (const { stream, transport, native } of [legacy, ordinary]) {
      const frame = { live: '🦊'.repeat(15000) };
      let shouldPause = true;
      stream.onData(() => {
        if (shouldPause) {
          shouldPause = false;
          stream.pause();
        }
      });
      push(native, frame);
      assert.deepEqual(await transport.read(1000), frame);
      const reads = native.reads;
      await tick();
      assert.equal(native.reads, reads, 'pause blocks the next native read');
      const queued = { queued: '🦊'.repeat(15000) };
      push(native, queued);
      await collect();
      assert.ok(current.at(-1)?.deref(), 'unread native queue remains owned');
      stream.resume();
      assert.deepEqual(await transport.read(1000), queued);
    }
    // The current client uses a resumable stream; its already-consumed logical
    // receive buffer must not be kept alive by the outer byte-stream adapter.
    const native = new NativeInput();
    const logical = new ResumablePeerStream({ peerId: native.peerId });
    logical.attach(logical.nextAttachment().generation, {
      stream: native,
      remainder: Buffer.alloc(0),
      received: 0,
    });
    const stream = new RuntimeHostPeerByteStream(logical);
    const transport = new FramedByteStreamTransport(stream);
    streams.push(stream);
    framed.push(transport);
    const frame = { resumable: '🦊'.repeat(15000) };
    const payload = Buffer.from(JSON.stringify(frame) + '\n');
    const wire = Buffer.alloc(13 + payload.length);
    wire[0] = 1;
    wire.writeBigUInt64BE(0n, 1);
    wire.writeUInt32BE(payload.length, 9);
    payload.copy(wire, 13);
    const from = Buffer.from;
    const priorCount = current.length;
    Buffer.from = ((...args: Parameters<typeof Buffer.from>) => {
      const result = Reflect.apply(from, Buffer, args) as Buffer;
      if (new Error().stack?.split('\n')[2]?.includes('resumable-peer-stream.js')) {
        current.push(new WeakRef(result.buffer));
      }
      return result;
    }) as typeof Buffer.from;
    try {
      native.push(wire);
      assert.deepEqual(await transport.read(1000), frame);
      assert.equal(logical.received, payload.length);
      assert.equal(current.length, priorCount + 1);
    } finally {
      Buffer.from = from;
    }
    await collect();
    // All delivery and backpressure checks precede the lifetime assertions.
    assert.deepEqual(
      [initial, current].map((refs) => refs.filter((weak) => weak.deref() !== undefined).length),
      [0, 0],
      'no consumed backing remains in either the connection or its pending read loop',
    );
    assert.equal(streams.length, 3);
  } finally {
    for (const transport of framed) transport.abort();
    await Promise.all(streams.map((stream) => stream.closed));
  }
});

test('peer byte-stream dispatch preserves errors, EOF and writes', async () => {
  for (const initial of [false, true]) {
    const native = new NativeInput();
    const stream = new RuntimeHostPeerByteStream(
      native,
      initial ? Buffer.from('initial') : undefined,
    );
    const errors: Error[] = [];
    stream.onError((error) => errors.push(error));
    stream.onData(() => {
      throw new Error('dispatch failed');
    });
    if (!initial) native.push(Buffer.from('chunk'));
    await stream.closed;
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.message, 'dispatch failed');
    assert.equal(native.pending, undefined);
  }
  const native = new NativeInput();
  const stream = new RuntimeHostPeerByteStream(native);
  let ended = 0;
  stream.onEnd(() => ended++);
  await tick();
  native.abort();
  await stream.closed;
  assert.equal(ended, 1);

  const written: Buffer[] = [];
  const writable = new RuntimeHostPeerByteStream({
    ...new NativeInput(),
    read: async () => null,
    write: async (chunk) => {
      written.push(chunk);
    },
    close: async () => {},
    abort: () => {},
  });
  const bytes = Buffer.from('outgoing');
  await writable.write(bytes);
  assert.equal(written[0], bytes);
  await writable.closed;
});
