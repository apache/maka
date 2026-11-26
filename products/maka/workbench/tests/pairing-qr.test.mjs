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
import { pairingQr } from '../app/pairingQr.ts';

const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];

test('selects the smallest byte-mode QR version and draws all three finder patterns', () => {
  for (const [bytes, size] of [
    [17, 21],
    [18, 25],
    [500, 77],
    [900, 101],
  ]) {
    const matrix = pairingQr('a'.repeat(bytes));
    assert.equal(matrix.length, size);
    assert.ok(matrix.every((row) => row.length === size && row.every((bit) => bit <= 1)));
    for (const [x, y] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ]) {
      assert.deepEqual(
        matrix.slice(y, y + 7).map((row) => row.slice(x, x + 7).join('')),
        finder,
      );
    }
  }
});

test('honors maximum QR byte capacity without truncating an invitation', () => {
  assert.equal(pairingQr('a'.repeat(2953)).length, 177);
  assert.equal(pairingQr('a'.repeat(2954)), null);
});
