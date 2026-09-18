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
  mergePromptAnchorRailTurns,
  observeActivePromptRailVisibility,
  selectPromptRailTick,
} from '../prompt-anchor-rail.js';

test('indexed Turns outside the loaded range precede it, and loaded Turns keep their own entries', () => {
  const loaded = [
    { turnId: 'turn-3', label: 'Prompt 3', reply: 'Answer 3' },
    { turnId: 'turn-4', label: 'Prompt 4', reply: 'Answer 4' },
  ];
  const index = [
    { turnId: 'turn-1', sequence: 8, label: 'Prompt 1' },
    { turnId: 'turn-3', sequence: 40, label: 'Prompt 3' },
  ];
  assert.deepEqual(mergePromptAnchorRailTurns(loaded, index, new Set(['turn-2', 'turn-3', 'turn-4'])), [
    { turnId: 'turn-1', sequence: 8, label: 'Prompt 1' },
    ...loaded,
  ]);
  assert.equal(mergePromptAnchorRailTurns(loaded, undefined, new Set()), loaded);
  assert.equal(mergePromptAnchorRailTurns(loaded, index.slice(1), new Set(['turn-3'])), loaded);
});

const orderedTurnIds = Array.from({ length: 120 }, (_, index) => `turn-${index + 1}`);
const sampledRailTurnIds = Array.from({ length: 64 }, (_, railIndex) =>
  orderedTurnIds[Math.round(railIndex * 119 / 63)]!,
);

test('a sampled rail projects the reading Turn onto the tick that stands for it', () => {
  assert.equal(selectPromptRailTick({
    readingTurnId: 'turn-67',
    orderedTurnIds,
    railTurnIds: sampledRailTurnIds,
    previousRailTurnId: null,
  }), 'turn-67', 'a sampled Turn is its own tick');
  // 120 Turns over 64 ticks: turn-66 has none of its own.
  assert.equal(sampledRailTurnIds.includes('turn-66'), false);
  assert.equal(selectPromptRailTick({
    readingTurnId: 'turn-66',
    orderedTurnIds,
    railTurnIds: sampledRailTurnIds,
    previousRailTurnId: null,
  }), 'turn-65');
});

test('every Turn is its own tick while the rail is under its cap', () => {
  assert.equal(selectPromptRailTick({
    readingTurnId: 'turn-2',
    orderedTurnIds: ['turn-1', 'turn-2', 'turn-3'],
    railTurnIds: ['turn-1', 'turn-2', 'turn-3'],
    previousRailTurnId: 'turn-1',
  }), 'turn-2');
});

test('a reading position the rail has no landmark for keeps the current tick', () => {
  assert.equal(selectPromptRailTick({
    readingTurnId: 'unindexed-turn',
    orderedTurnIds: ['turn-1', 'turn-2', 'turn-3'],
    railTurnIds: ['turn-1', 'turn-2', 'turn-3'],
    previousRailTurnId: 'turn-2',
  }), 'turn-2');
});

test('no reading position and no usable current tick leaves the rail unmarked', () => {
  assert.equal(selectPromptRailTick({
    readingTurnId: undefined,
    orderedTurnIds: ['turn-1', 'turn-2', 'turn-3'],
    railTurnIds: ['turn-1', 'turn-2', 'turn-3'],
    previousRailTurnId: 'turn-from-another-session',
  }), null);
});

test('keeps the active tick visible when the rail viewport resizes', () => {
  let railBox = box(0, 600);
  let tickBox = box(570, 590);
  let onResize: (() => void) | undefined;
  let observed: Element | undefined;
  let disconnected = false;
  const tick = {
    getBoundingClientRect: () => tickBox,
  } as HTMLElement;
  const rail = {
    scrollTop: 384,
    getBoundingClientRect: () => railBox,
    querySelector: () => tick,
  } as unknown as HTMLElement;

  const cleanup = observeActivePromptRailVisibility(rail, (callback) => {
    onResize = callback;
    return {
      observe: (target) => {
        observed = target;
      },
      disconnect: () => {
        disconnected = true;
      },
    };
  });

  assert.equal(observed, rail);
  assert.equal(rail.scrollTop, 384, 'the initial visible tick does not move the rail');

  railBox = box(0, 286);
  onResize?.();
  assert.equal(rail.scrollTop, 688, 'a shorter rail brings the active tick back from below');

  tickBox = box(-30, -10);
  onResize?.();
  assert.equal(rail.scrollTop, 658, 'the same observer also restores a tick above the rail');

  cleanup();
  assert.equal(disconnected, true);
});

function box(top: number, bottom: number): DOMRect {
  return { top, bottom } as DOMRect;
}
