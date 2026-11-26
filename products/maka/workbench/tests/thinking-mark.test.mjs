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
import {
  freshWords,
  MARK_CYCLE,
  MARK_SAMPLES,
  MARK_STROKES,
  markPhase,
  strokeAt,
  thoughtTail,
} from '../app/thinkingMark.ts';

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
      // The cycle starts over where it ended: in place, half a turn on.
      const [first, last] = [samples[0], samples.at(-1)];
      assert.ok(Math.abs(Math.abs(last.turn - first.turn) - 180) < 1e-9);
      assert.ok(Math.abs(last.scale - first.scale) < 1e-9);
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

test('the thinking mark stands whole for a good part of every cycle', () => {
  let whole = 0;
  for (let at = 0; at < MARK_SAMPLES; at += 1)
    if ([...MARK_STROKES.keys()].every((index) => strokeAt(index, at / MARK_SAMPLES).opacity === 1))
      whole += 1;
  assert.ok(whole / MARK_SAMPLES > 0.2);
  // Apart, the strokes are never all far off together: the mark does not blink.
  for (let at = 0; at < MARK_SAMPLES; at += 1)
    assert.ok(
      [...MARK_STROKES.keys()].some((index) => strokeAt(index, at / MARK_SAMPLES).opacity > 0.5),
    );
});

test('the newest words of a thought are split cleanly without dropping text, in any script', () => {
  for (const sample of ['one two three four five six', '对比资金流向和新闻']) {
    const parts = freshWords(sample);
    assert.equal(parts.settled + parts.fresh.join(''), sample);
    assert.ok(parts.settled.length > 0);
    assert.ok(parts.fresh.length > 0 && parts.fresh.length <= 4);
  }
  const short = freshWords('hi');
  assert.equal(short.settled, '');
  assert.equal(short.fresh.join(''), 'hi');
});

test('a mark begins with its strokes arriving, and one that takes its place carries on', () => {
  const first = markPhase(10_000);
  // Entering from rest starts mid-flight, not already whole.
  assert.ok([...MARK_STROKES.keys()].some((index) => strokeAt(index, 0, first.phase).opacity < 1));
  // Overlapping or briefly handed-off marks carry the clock phase forward.
  const second = markPhase(11_000);
  assert.ok(Math.abs(((second.phase - first.phase + 1) % 1) - 1000 / MARK_CYCLE) < 1e-9);
  first.gone(11_000);
  second.gone(11_100);
  const third = markPhase(11_300);
  assert.ok(Math.abs(((third.phase - first.phase + 1) % 1) - 1300 / MARK_CYCLE) < 1e-9);
  third.gone(12_000);
  // After a pause with no mark, the next one begins anew at the entrance phase.
  const fresh = markPhase(20_000);
  assert.ok(Math.abs(fresh.phase - first.phase) < 1e-9);
  fresh.gone(20_100);
});
