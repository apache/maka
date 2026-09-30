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

import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { createSessionSwipe } from '../../renderer/features/session-navigation/testing.js';

it('gives fast swipes a slower animation while retaining the current timing for slow pulls', () => {
  const fast = createSessionSwipe();
  fast.sample({ deltaX: -20, deltaY: 0, timeStamp: 0, eligible: true });
  fast.sample({ deltaX: -60, deltaY: 0, timeStamp: 30, eligible: true });
  assert.deepEqual(fast.motion(), { arrivalMs: 280, opacityMs: 300, holdMs: 320, returnMs: 420 });
  const slow = createSessionSwipe();
  slow.sample({ deltaX: -20, deltaY: 0, timeStamp: 0, eligible: true });
  slow.sample({ deltaX: -60, deltaY: 0, timeStamp: 180, eligible: true });
  assert.deepEqual(slow.motion(), { arrivalMs: 180, opacityMs: 200, holdMs: 200, returnMs: 320 });
});

it('moves once per horizontal gesture including its momentum tail', () => {
  const swipe = createSessionSwipe();
  const directions = [0, 16, 32, 48, 100, 180, 320, 460].map((timeStamp) =>
    swipe.sample({ deltaX: -30, deltaY: 2, timeStamp, eligible: true }).direction);
  assert.deepEqual(directions, [null, null, -1, null, null, null, null, null]);
  assert.deepEqual(swipe.sample({ deltaX: 90, deltaY: 0, timeStamp: 800, eligible: true }),
    { claimed: true, direction: 1 });
});

it('does not claim vertical frames after committing a horizontal gesture', () => {
  const swipe = createSessionSwipe();
  swipe.sample({ deltaX: -100, deltaY: 0, timeStamp: 0, eligible: true });
  for (let timeStamp = 100; timeStamp <= 1000; timeStamp += 100) {
    assert.deepEqual(swipe.sample({ deltaX: 0, deltaY: 50, timeStamp, eligible: true }),
      { claimed: false, direction: null });
  }
  assert.deepEqual(swipe.sample({ deltaX: -3, deltaY: 50, timeStamp: 1100, eligible: true }),
    { claimed: false, direction: null });
  // Letting vertical input through does not release the horizontal tail latch.
  assert.deepEqual(swipe.sample({ deltaX: -30, deltaY: 0, timeStamp: 1200, eligible: true }),
    { claimed: true, direction: null });
});

it('recognizes a renewed same-direction stroke in the captured Windows stream without waiting for idle', () => {
  const swipe = createSessionSwipe();
  // Rounded physical capture: initial stroke, decaying/coalesced tail, then
  // two renewed strokes. No adjacent frames have a 250 ms idle gap.
  const samples = [
    [0, -2], [23, -10], [42, -18], [65, -25], [67, -22], [90, -22],
    [139, -50], [188, -58], [210, -18], [241, -38], [286, -55],
    [313, -28], [338, -13], [357, -12], [380, -10], [405, -10],
    [488, -8], [501, -37], [507, -5], [520, -5], [544, -5],
    [557, -5], [579, -3], [637, -5],
    [672, -18], [690, -27], [713, -32], [731, -30], [738, -22],
    [752, -15], [768, -12], [791, -8], [805, -5], [828, -27],
    [866, -13], [873, -13], [889, -13], [908, -13], [925, -15],
    [1028, -67], [1033, -8], [1070, -8], [1149, -2], [1152, -5],
    [1188, -55], [1210, -43],
  ];
  const moves = samples.flatMap(([timeStamp, deltaX]) =>
    swipe.sample({ timeStamp, deltaX, deltaY: 0, eligible: true }).direction === -1 ? [timeStamp] : []);
  assert.deepEqual(moves, [90, 731, 1210]);
});

it('recognizes a horizontal swipe after a small diagonal start instead of discarding the gesture', () => {
  const swipe = createSessionSwipe();
  const directions = [
    { deltaX: -4, deltaY: 9 },
    { deltaX: -18, deltaY: 3 },
    { deltaX: -28, deltaY: 1 },
    { deltaX: -32, deltaY: 0 },
  ].map((sample, index) => swipe.sample({ ...sample, timeStamp: index * 16, eligible: true }).direction);
  assert.deepEqual(directions, [null, null, null, -1]);
});

it('does not mistake a quiet tail followed by vertical scrolling for a renewed horizontal stroke', () => {
  const swipe = createSessionSwipe();
  swipe.sample({ deltaX: -100, deltaY: 0, timeStamp: 0, eligible: true });
  swipe.sample({ deltaX: -5, deltaY: 0, timeStamp: 200, eligible: true });
  swipe.sample({ deltaX: -5, deltaY: 0, timeStamp: 240, eligible: true });
  const moves = [[260, -50, 100], [280, -40, 0], [300, -40, 0]].map(([timeStamp, deltaX, deltaY]) =>
    swipe.sample({ timeStamp, deltaX, deltaY, eligible: true }).direction);
  assert.deepEqual(moves, [null, null, null]);
});

it('retains renewal readiness through the weak opening frame in the second Windows capture', () => {
  const swipe = createSessionSwipe();
  // A real missed forward stroke: history was available and every frame was
  // eligible. The 10 px opening frame must not discard the settled tail.
  const samples = [[0, 100], [200, 2], [225, 2], [246, 2], [377, 2],
    [402, 10], [463, 30], [467, 32], [483, 132]];
  const moves = samples.flatMap(([timeStamp, deltaX]) =>
    swipe.sample({ timeStamp, deltaX, deltaY: 0, eligible: true }).direction === 1 ? [timeStamp] : []);
  assert.deepEqual(moves, [0, 483]);
});

it('reports continuous pull progress and allows retracting before the threshold', () => {
  const swipe = createSessionSwipe();
  swipe.sample({ deltaX: -24, deltaY: 0, timeStamp: 0, eligible: true });
  assert.deepEqual(swipe.feedback(), { direction: -1, progress: 0.3, committed: false });
  swipe.sample({ deltaX: -16, deltaY: 0, timeStamp: 16, eligible: true });
  assert.deepEqual(swipe.feedback(), { direction: -1, progress: 0.5, committed: false });
  swipe.sample({ deltaX: 20, deltaY: 0, timeStamp: 32, eligible: true });
  assert.deepEqual(swipe.feedback(), { direction: -1, progress: 0.25, committed: false });
  assert.equal(swipe.sample({ deltaX: -60, deltaY: 0, timeStamp: 48, eligible: true }).direction, -1);
  assert.deepEqual(swipe.feedback(), { direction: -1, progress: 1, committed: true });
});

it('accepts a deliberate opposite swipe without waiting out the previous momentum latch', () => {
  const swipe = createSessionSwipe();
  swipe.sample({ deltaX: -90, deltaY: 0, timeStamp: 0, eligible: true });
  // Tiny recoil at the end of a gesture is not another navigation.
  assert.equal(swipe.sample({ deltaX: 3, deltaY: 0, timeStamp: 16, eligible: true }).direction, null);
  assert.equal(swipe.sample({ deltaX: -4, deltaY: 0, timeStamp: 32, eligible: true }).direction, null);
  assert.equal(swipe.sample({ deltaX: 30, deltaY: 1, timeStamp: 100, eligible: true }).direction, null);
  assert.deepEqual(swipe.feedback(), { direction: 1, progress: 0.375, committed: false });
  assert.equal(swipe.sample({ deltaX: 55, deltaY: 1, timeStamp: 116, eligible: true }).direction, 1);
});

it('locks vertical, diagonal and excluded gestures out until idle', () => {
  for (const first of [
    { deltaX: 3, deltaY: 20, eligible: true },
    { deltaX: 20, deltaY: 18, eligible: true },
    { deltaX: 30, deltaY: 0, eligible: false },
  ]) {
    const swipe = createSessionSwipe();
    assert.deepEqual(swipe.sample({ ...first, timeStamp: 0 }), { claimed: false, direction: null });
    assert.deepEqual(swipe.sample({ deltaX: 120, deltaY: 0, timeStamp: 30, eligible: true }),
      { claimed: false, direction: null });
    assert.deepEqual(swipe.sample({ deltaX: -90, deltaY: 0, timeStamp: 400, eligible: true }),
      { claimed: true, direction: -1 });
  }
});
