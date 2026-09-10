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
import { fileURLToPath } from 'node:url';
import { setImmediate as immediate } from 'node:timers/promises';
import test from 'node:test';
import {
  FramedByteStreamTransport,
  type RuntimeHostByteStream,
} from '../transport/framed-byte-stream-transport.js';

test('drained framed transports release consumed buffers without dropping queued or partial frames', async () => {
  if (!global.gc) {
    assert.notEqual(process.env.MAKA_FRAMED_BUFFER_GC_CHILD, '1', 'child must expose GC');
    const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], {
      env: { ...process.env, MAKA_FRAMED_BUFFER_GC_CHILD: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return;
  }
  const observers: Array<WeakRef<ArrayBufferLike>> = [];
  const owned: FramedByteStreamTransport[] = [];
  for (const mode of ['complete', 'queued', 'partial'] as const) {
    let onData: (chunk: Buffer) => void = () => assert.fail('missing receiver');
    let onEnd: () => void = () => assert.fail('missing end listener');
    let finishClose: () => void = () => {};
    let pauses = 0;
    let resumes = 0;
    const stream: RuntimeHostByteStream = {
      closed: new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
      onData: (listener) => {
        onData = listener;
      },
      onEnd: (listener) => {
        onEnd = listener;
      },
      onError: () => {},
      write: async () => {},
      closeAfterFlush: () => finishClose(),
      abort: () => finishClose(),
      pause: () => {
        pauses += 1;
      },
      resume: () => {
        resumes += 1;
      },
    };
    const transport = new FramedByteStreamTransport(stream);
    owned.push(transport);
    try {
      const count = mode === 'queued' ? 96 : 1;
      const frames = Array.from({ length: count }, (_, index) => ({
        index,
        payload: '🦊'.repeat(5000),
      }));
      const bytes = Buffer.from(
        frames.map((frame) => JSON.stringify(frame) + '\n').join('') +
          (mode === 'partial' ? '{"tail":' : ''),
      );
      const from = Buffer.from;
      let captured = false;
      Buffer.from = ((...args: Parameters<typeof Buffer.from>) => {
        const result = Reflect.apply(from, Buffer, args) as Buffer;
        if (!captured) {
          captured = true;
          assert.equal(result.byteLength, bytes.byteLength);
          observers.push(new WeakRef(result.buffer));
        }
        return result;
      }) as typeof Buffer.from;
      try {
        onData(bytes);
      } finally {
        Buffer.from = from;
      }
      assert.equal(captured, true);
      // The producer may reuse its input after the callback: pending bytes stay owned.
      bytes.fill(0);
      if (mode === 'queued') assert.equal(pauses, 1);
      for (const frame of frames) assert.deepEqual(await transport.read(1000), frame);
      if (mode === 'queued') assert.equal(resumes, 1);
      if (mode === 'partial') {
        for (let i = 0; i < 4; i += 1) {
          await immediate();
          global.gc();
        }
        assert.ok(observers.at(-1)?.deref(), 'unread partial frame must remain owned');
        const pending = transport.read(1000);
        onData(Buffer.from('true}\r\n'));
        assert.deepEqual(await pending, { tail: true });
        onEnd();
        await assert.rejects(transport.read(1000), { code: 'read_eof' });
      }
    } catch (error) {
      for (const item of owned) item.abort();
      throw error;
    }
  }
  try {
    for (let i = 0; i < 12; i += 1) {
      await immediate();
      global.gc();
    }
    assert.equal(observers.filter((weak) => weak.deref() !== undefined).length, 0);
    assert.equal(owned.length, 3, 'transports remain alive for the retention assertion');
  } finally {
    for (const transport of owned) transport.abort();
    await Promise.all(owned.map((transport) => transport.closed));
  }
});
