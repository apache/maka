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
import { allocateWorkHubHues } from '../../renderer/features/workhub/testing.js';

test('cycles through six retained bands in order, then starts the next cycle', () => {
  const ids = Array.from({ length: 14 }, (_, index) => `work-${String(index).padStart(2, '0')}`);
  const hues = allocateWorkHubHues(ids);
  ids.forEach((id, index) => {
    const hue = hues.get(id)!;
    const start = (index % 6) * 60;
    assert.ok(hue >= start && hue < start + 30, `${id}: ${hue} outside band ${start}`);
  });
  assert.deepEqual(allocateWorkHubHues([...ids].reverse()), hues);
});

test('samples within each band instead of using six fixed hues', () => {
  const hues = [...allocateWorkHubHues(Array.from({ length: 60 }, (_, i) => `work-${i}`)).values()];
  for (let band = 0; band < 6; band++) {
    const values = hues.filter((hue) => Math.floor(hue / 60) === band);
    assert.equal(values.length, 10);
    assert.ok(new Set(values).size > 1);
    assert.ok(values.every((hue) => hue % 60 < 30));
  }
});

test('filtering, reordering and adding Works preserve colors and the band cursor', () => {
  const initial = allocateWorkHubHues(['b', 'c', 'd', 'b']);
  assert.equal(allocateWorkHubHues(['d'], initial), initial);
  assert.equal(allocateWorkHubHues(['d', 'b', 'c'], initial), initial);
  const extended = allocateWorkHubHues(['a', 'd'], initial);
  for (const [id, hue] of initial) assert.equal(extended.get(id), hue);
  assert.equal(extended.size, 4);
  assert.ok(extended.get('a')! >= 180 && extended.get('a')! < 210);
});

test('empty input is a no-op and fresh renders sample deterministically', () => {
  const empty = new Map<string, number>();
  assert.equal(allocateWorkHubHues([], empty), empty);
  assert.deepEqual(allocateWorkHubHues(['same-id']), allocateWorkHubHues(['same-id']));
});
