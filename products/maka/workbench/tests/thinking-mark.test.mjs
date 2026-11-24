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
import { MARK_SAMPLES, MARK_STROKES, strokeAt, thoughtTail } from '../app/thinkingMark.ts';

test('no stroke of the thinking mark jumps between samples, at any phase', () => {
  for (const index of MARK_STROKES.keys())
    for (const phase of [0, 0.13, 0.2, 0.36, 0.5, 0.77, 0.999]) {
      const samples = Array.from({ length: MARK_SAMPLES + 1 }, (_, at) =>
        strokeAt(index, at / MARK_SAMPLES, phase),
      );
      for (let at = 1; at < samples.length; at += 1) {
        const [before, after] = [samples[at - 1], samples[at]];
        assert.ok(Math.abs(after.turn - before.turn) < 90, `turn of ${index} at ${at}, ${phase}`);
        assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 3);
      }
      // The cycle starts over where it ended: in place, a whole turn on.
      const [first, last] = [samples[0], samples.at(-1)];
      assert.ok(Math.abs(Math.abs(last.turn - first.turn) - 360) < 1e-9);
      assert.ok(Math.hypot(last.x - first.x, last.y - first.y) < 1e-9);
      assert.ok(Math.abs(last.opacity - first.opacity) < 1e-9);
    }
});

test('the tail of a thought stays short when its last paragraph is long', () => {
  const long = `first\n${'word '.repeat(2000)}`;
  assert.ok(thoughtTail(long).length <= 720);
  assert.equal(thoughtTail(`${'a'.repeat(100)}\n${'b'.repeat(500)}`), 'b'.repeat(500));
});

test('thoughtTail strips Markdown marks without altering inline code', () => {
  assert.equal(thoughtTail('**Plan*'), 'Plan');
  assert.equal(thoughtTail('**Plan**'), 'Plan');
  assert.equal(thoughtTail('**Plan** '), 'Plan');
  assert.equal(
    thoughtTail('## Plan\n\nMatch `**/*.ts` and `src/*`'),
    'Plan\nMatch **/*.ts and src/*',
  );
  assert.equal(thoughtTail('`*`'), '*');
  assert.equal(thoughtTail('**Checking** the `price` now *'), 'Checking the price now ');
});
