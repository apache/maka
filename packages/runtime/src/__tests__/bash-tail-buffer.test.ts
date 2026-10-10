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
import { describe, test } from 'node:test';
import { BashTailBuffer } from '../bash-tail-buffer.js';

describe('BashTailBuffer', () => {
  test('bounds retained output to the exact tail', () => {
    const buf = new BashTailBuffer(20);
    for (let i = 0; i < 100; i++) buf.push(`line${i}\n`);
    const value = buf.value();
    assert.ok(value.length <= 20);
    assert.ok(value.endsWith('line99\n')); // tail preserved
    assert.equal(value, 'ine97\nline98\nline99\n');
  });

  test('keeps the tail of an oversized line', () => {
    const buf = new BashTailBuffer(5);
    buf.push('abcdefghij');
    assert.equal(buf.value(), 'fghij');
  });

  test('retains the same tail across chunk boundaries', () => {
    const buf = new BashTailBuffer(6);
    buf.push('abc');
    buf.push('def');
    buf.push('ghi');
    assert.equal(buf.value(), 'defghi');
  });

  test('does not split a surrogate pair at the truncation boundary', () => {
    for (const [cap, expected] of [
      [3, '😀x'],
      [2, 'x'],
    ] as const) {
      const buf = new BashTailBuffer(cap);
      buf.push('abc😀x');
      assert.equal(buf.value(), expected);
    }
  });
});
