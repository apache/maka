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

it('moves once per horizontal gesture including its momentum tail', () => {
  const swipe = createSessionSwipe();
  const directions = [0, 16, 32, 48, 100, 180, 320, 460].map((timeStamp) =>
    swipe.sample({ deltaX: -30, deltaY: 2, timeStamp, eligible: true }).direction);
  assert.deepEqual(directions, [null, null, -1, null, null, null, null, null]);
  assert.deepEqual(swipe.sample({ deltaX: 90, deltaY: 0, timeStamp: 800, eligible: true }),
    { claimed: true, direction: 1 });
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
