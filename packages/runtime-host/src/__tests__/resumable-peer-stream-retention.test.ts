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
import test from 'node:test';

test('open resumable peer releases consumed backing buffers but preserves pending data', () => {
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { ResumablePeerStream } from ${moduleUrl('../transport/resumable-peer-stream.js')};
    import { readRuntimeHostPeerAuthenticationResult } from ${moduleUrl('../transport/peer-native.js')};

    // Observe native allocations and every large parser/payload copy. Small
    // pooled control frames share slabs and cannot establish individual ownership.
    const tracked = [];
    let stage = 'auth';
    function observe(buffer, kind) {
      if (buffer.length >= 4096) tracked.push({ stage, kind, size: buffer.length,
        backing: new WeakRef(buffer.buffer) });
      return buffer;
    }
    for (const kind of ['from', 'concat']) {
      const original = Buffer[kind];
      Buffer[kind] = function (...args) {
        return observe(Reflect.apply(original, Buffer, args), kind);
      };
    }
    class Native {
      peerId = 'peer'; path = { kind: 'direct', transport: 'tcp' };
      queue = []; pending; ended = false; acknowledged = -1; written = 0;
      read() {
        if (this.queue.length) return Promise.resolve(this.queue.shift());
        if (this.ended) return Promise.resolve(null);
        return new Promise(resolve => this.pending = resolve);
      }
      push(bytes) {
        assert(bytes.length <= 65536, 'native reads are bounded to 64 KiB');
        observe(bytes, 'native');
        if (this.pending) {
          const resolve = this.pending; this.pending = undefined; resolve(bytes);
        } else this.queue.push(bytes);
      }
      async write(bytes) {
        if (bytes[0] === 2) this.acknowledged = Number(bytes.readBigUInt64BE(1));
        if (bytes[0] === 1) {
          assert.equal(bytes.readUInt32BE(9), 65536);
          assert(bytes.subarray(13).every(byte => byte === 42), 'replay payload preserved');
          this.written++;
        }
      }
      abort() {
        this.ended = true; this.queue.length = 0;
        this.pending?.(null); this.pending = undefined;
      }
    }
    function frame(type, offset, size = 0, length = 13 + size) {
      const bytes = Buffer.alloc(length, 65);
      bytes[0] = type; bytes.writeBigUInt64BE(BigInt(offset), 1);
      bytes.writeUInt32BE(size, 9);
      return bytes;
    }
    async function collect() {
      for (let i = 0; i < 8; i++) { await setImmediate(); global.gc(); }
      await setImmediate();
    }
    function alive() {
      return tracked.filter(item => item.backing.deref()).map(({ stage, kind, size }) =>
        ({ stage, kind, size }));
    }
    function released(label) { assert.deepEqual(alive(), [], label); }
    function observed(label, kind) {
      assert(tracked.some(item => item.stage === label && item.kind === kind),
        label + ' observed ' + kind);
    }
    async function consume(stream, size) {
      let total = 0;
      while (total < size) {
        const bytes = await stream.read();
        assert(bytes); assert(bytes.every(byte => byte === 65)); total += bytes.length;
      }
      assert.equal(total, size);
      await setImmediate();
    }
    async function attachAuthenticated(stream) {
      const native = new Native();
      const header = Buffer.from(JSON.stringify({ v: 2, accepted: true,
        resume: { received: 0 } }) + '\\n');
      const size = 65536 - header.length - 13;
      native.push(Buffer.concat([header, frame(1, stream.received, size)]));
      const auth = await readRuntimeHostPeerAuthenticationResult(native);
      assert.equal(auth.accepted, true);
      stream.attach(stream.nextAttachment().generation,
        { stream: native, remainder: auth.remainder, received: auth.resume.received });
      await consume(stream, size);
      assert.equal(native.acknowledged, stream.received);
      return native;
    }
    const stream = new ResumablePeerStream({ peerId: 'peer', heartbeatMs: 1e9 });
    let closed = false;
    void stream.closed.then(() => { closed = true; });
    try {
      let native = await attachAuthenticated(stream);
      await collect();
      for (const kind of ['native', 'from', 'concat']) observed('auth', kind);
      released('consumed authentication remainder released while attachment stays open');

      stage = 'steady';
      native.push(frame(1, stream.received, 65523));
      await consume(stream, 65523);
      assert.equal(native.acknowledged, stream.received);
      await collect();
      for (const kind of ['native', 'from', 'concat']) observed('steady', kind);
      released('consumed native DATA and parser copies released without more traffic');

      stage = 'partial';
      native.push(frame(1, stream.received, 65536, 32768));
      await collect();
      assert.deepEqual(alive(), [{ stage, kind: 'concat', size: 32768 }],
        'incomplete frame retains only its parser buffer');
      stage = 'completion';
      native.push(Buffer.alloc(32781, 65));
      await consume(stream, 65536);
      assert.equal(native.acknowledged, stream.received);
      await collect();
      for (const kind of ['native', 'from', 'concat']) observed('completion', kind);
      released('body-read native chunk and completed partial frame released');

      stage = 'unread';
      native.push(frame(1, stream.received, 65523));
      await collect();
      assert.deepEqual(alive(), [{ stage, kind: 'from', size: 65523 }],
        'unread receive payload remains available');
      assert.equal(native.acknowledged, stream.received);
      await consume(stream, 65523);
      assert.equal(native.acknowledged, stream.received);
      await collect();
      released('receive payload released after consumption and ACK');

      stage = 'write';
      await stream.write(observe(Buffer.alloc(65536, 42), 'caller'));
      await collect();
      assert.equal(native.written, 1);
      assert.deepEqual(alive(), [{ stage, kind: 'from', size: 65536 }],
        'unACKed replay payload remains owned');
      native = new Native();
      stream.attach(stream.nextAttachment().generation,
        { stream: native, remainder: Buffer.alloc(0), received: 0 });
      await collect();
      assert.equal(native.written, 1, 'replacement replays the full unACKed payload');
      assert.deepEqual(alive(), [{ stage, kind: 'from', size: 65536 }]);
      native.push(frame(2, 65536));
      await collect();
      released('ACK releases replay payload while replacement remains open');
      assert.equal(closed, false);
      assert.equal(native.ended, false);
    } finally { stream.abort(); }
  `,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
