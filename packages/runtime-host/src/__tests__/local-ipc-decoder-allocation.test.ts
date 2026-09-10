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
import { RUNTIME_HOST_MAX_MESSAGE_BYTES } from '../protocol/index.js';
import { LocalIpcProtocolFrameDecoder } from '../transport/local-ipc-framing.js';

test('decoder retains owned partial frames and exact validation while avoiding empty-prefix copies', () => {
  let redundantBytes = 0;
  const concat = Buffer.concat;
  Buffer.concat = (list, length) => {
    if (list.length === 2 && list[0]?.byteLength === 0) redundantBytes += list[1]?.byteLength ?? 0;
    return concat(list, length);
  };
  try {
    const values = [null, true, 42, {}, [], { text: '中文🦊\\\"\ud800', lines: ['a', 'b'] }];
    for (const value of values) {
      for (const ending of ['\n', '\r\n']) {
        const bytes = Buffer.from(JSON.stringify(value) + ending);
        for (let split = 0; split <= bytes.length; split += 1) {
          const decoder = new LocalIpcProtocolFrameDecoder();
          const first = Buffer.from(bytes.subarray(0, split));
          const actual = decoder.push(first);
          first.fill(0);
          actual.push(...decoder.push(bytes.subarray(split)));
          assert.deepEqual(actual, [value]);
          decoder.end();
        }
      }
    }
    const burst = Buffer.from(values.map((value) => JSON.stringify(value)).join('\n') + '\n');
    const decoder = new LocalIpcProtocolFrameDecoder();
    assert.deepEqual(decoder.push(burst), values);
    decoder.end();

    const full = { v: 'x'.repeat(RUNTIME_HOST_MAX_MESSAGE_BYTES - 8) };
    const fullBytes = Buffer.from(JSON.stringify(full) + '\n');
    assert.equal(fullBytes.length, RUNTIME_HOST_MAX_MESSAGE_BYTES + 1);
    assert.deepEqual(new LocalIpcProtocolFrameDecoder().push(fullBytes), [full]);

    const cases: Array<{ bytes: Buffer; code: string }> = [
      { bytes: Buffer.from('\n'), code: 'invalid_frame' },
      { bytes: Buffer.from('\r\n'), code: 'invalid_json' },
      { bytes: Buffer.from('{invalid}\n'), code: 'invalid_json' },
      { bytes: Buffer.from([0xff, 0x0a]), code: 'invalid_utf8' },
      {
        bytes: Buffer.from('"' + 'x'.repeat(RUNTIME_HOST_MAX_MESSAGE_BYTES) + '"\n'),
        code: 'frame_too_large',
      },
    ];
    for (const { bytes, code } of cases) {
      assert.throws(() => new LocalIpcProtocolFrameDecoder().push(bytes), { code });
    }
    const partial = new LocalIpcProtocolFrameDecoder();
    assert.deepEqual(partial.push(Buffer.from('{"pending":')), []);
    assert.throws(() => partial.end(), { code: 'invalid_frame' });
    assert.deepEqual(partial.push(Buffer.from('true}\n')), [{ pending: true }]);
    partial.end();
    const empty = new LocalIpcProtocolFrameDecoder();
    assert.deepEqual(empty.push(new Uint8Array()), []);
    empty.end();
  } finally {
    Buffer.concat = concat;
  }
  assert.equal(redundantBytes, 0);
});
