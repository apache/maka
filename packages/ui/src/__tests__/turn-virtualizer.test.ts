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
import { describe, it } from 'node:test';
import {
  buildTurnVirtualLayout,
  estimatedTurnHeight,
  initialTurnVirtualWindow,
  reconcileTurnVirtualWindow,
  stableTurnVirtualWindowForViewport,
  turnVirtualWindowForRange,
  turnVirtualWindowForViewport,
  turnVirtualizationRequired,
} from '../turn-virtualizer.js';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `t${index}`);

describe('turn virtualizer', () => {
  it('uses observed turns to estimate unmeasured history', () => {
    assert.equal(estimatedTurnHeight(undefined), 280);
    assert.equal(estimatedTurnHeight(new Map([['short', 100]])), 190);
    assert.equal(estimatedTurnHeight(new Map([['a', 600], ['b', 1_000]])), 1_880 / 3);
  });

  it('starts with a bounded tail and exact spacer geometry', () => {
    const layout = buildTurnVirtualLayout(ids(200), undefined, { estimatedHeight: 100, gap: 4 });
    const window = initialTurnVirtualWindow(layout, 40);
    assert.deepEqual({ start: window.start, end: window.end }, { start: 160, end: 200 });
    assert.equal(window.beforeHeight, (160 * 100) + (159 * 4));
    assert.equal(window.afterHeight, 0);
  });

  it('recomputes spacer geometry without changing the mounted range', () => {
    const turnIds = ids(100);
    const estimated = buildTurnVirtualLayout(turnIds, undefined, { estimatedHeight: 100 });
    const initial = initialTurnVirtualWindow(estimated, 40);
    const measured = buildTurnVirtualLayout(
      turnIds,
      new Map(turnIds.slice(0, 60).map((id) => [id, 200])),
      { estimatedHeight: 100 },
    );
    const updated = turnVirtualWindowForRange(measured, initial.start, initial.end);
    assert.deepEqual(
      { start: updated.start, end: updated.end },
      { start: initial.start, end: initial.end },
    );
    assert.ok(updated.beforeHeight > initial.beforeHeight);
  });

  it('uses measurements and keeps a pixel overscan without exceeding the hard cap', () => {
    const turnIds = ids(500);
    const heights = new Map(turnIds.map((id, index) => [id, index % 2 === 0 ? 40 : 400]));
    const layout = buildTurnVirtualLayout(turnIds, heights);
    const window = turnVirtualWindowForViewport(
      layout,
      { scrollTop: 40_000, clientHeight: 900 },
      { overscanPx: 1_200, preferredTurns: 60, maxTurns: 100 },
    );
    assert.ok(window.end - window.start >= 60);
    assert.ok(window.end - window.start <= 100);
    assert.ok(layout.offsets[window.start]! <= 40_000);
    assert.ok(layout.offsets[window.end]! >= 40_900);
  });

  it('keeps the mounted window stable until the viewport reaches its overscan edge', () => {
    const layout = buildTurnVirtualLayout(
      ids(120),
      undefined,
      { estimatedHeight: 200, gap: 4 },
    );
    const current = turnVirtualWindowForViewport(
      layout,
      { scrollTop: 0, clientHeight: 800 },
    );
    assert.deepEqual([current.start, current.end], [0, 60]);

    const inside = stableTurnVirtualWindowForViewport(
      layout,
      current,
      { scrollTop: 8_000, clientHeight: 800 },
    );
    assert.deepEqual([inside.start, inside.end], [0, 60]);

    const crossed = stableTurnVirtualWindowForViewport(
      layout,
      current,
      { scrollTop: 11_000, clientHeight: 800 },
    );
    assert.equal(crossed.end - crossed.start, 60);
    assert.equal(crossed.start, current.start + 8);
  });

  it('retains focused and selected turns when a directional shift fits the hard cap', () => {
    const layout = buildTurnVirtualLayout(
      ids(120),
      undefined,
      { estimatedHeight: 200, gap: 4 },
    );
    const current = turnVirtualWindowForRange(layout, 0, 60);
    const shifted = stableTurnVirtualWindowForViewport(
      layout,
      current,
      { scrollTop: 11_000, clientHeight: 800 },
      { retainRange: { start: 0, end: 8 } },
    );

    assert.deepEqual([shifted.start, shifted.end], [0, 68]);
  });

  it('keeps visible identities across prepends and batched appends', () => {
    const beforeIds = ids(100);
    const beforeLayout = buildTurnVirtualLayout(beforeIds, undefined);
    const before = turnVirtualWindowForViewport(beforeLayout, { scrollTop: 8_000, clientHeight: 800 });
    const prepended = ['p0', 'p1', ...beforeIds];
    const afterPrepend = reconcileTurnVirtualWindow(
      beforeIds,
      buildTurnVirtualLayout(prepended, undefined),
      before,
    );
    assert.equal(prepended[afterPrepend.start], beforeIds[before.start]);
    assert.equal(prepended[afterPrepend.end - 1], beforeIds[before.end - 1]);

    const tail = initialTurnVirtualWindow(beforeLayout, 40);
    const appended = [...beforeIds, ...ids(80).map((id) => `a${id}`)];
    const afterAppend = reconcileTurnVirtualWindow(
      beforeIds,
      buildTurnVirtualLayout(appended, undefined),
      tail,
    );
    assert.equal(appended[afterAppend.start], beforeIds[tail.start]);
    assert.equal(appended[afterAppend.end - 1], beforeIds[tail.end - 1]);
    assert.equal(afterAppend.end - afterAppend.start, 40);
  });

  it('virtualizes by rendered distance before the turn-count cap', () => {
    const compact = buildTurnVirtualLayout(ids(8), undefined, { estimatedHeight: 90 });
    const tall = buildTurnVirtualLayout(ids(8), undefined, { estimatedHeight: 500 });

    assert.equal(turnVirtualizationRequired(compact, 800), false);
    assert.equal(turnVirtualizationRequired(compact, 800, 4_000), true);
    assert.equal(turnVirtualizationRequired(tall, 800), true);
    assert.equal(turnVirtualizationRequired(buildTurnVirtualLayout(ids(101), undefined), undefined), true);
  });

  it('expands a window that cannot cover the viewport without oscillating', () => {
    const layout = buildTurnVirtualLayout(
      ids(10),
      new Map([
        ['t4', 4_800],
        ['t5', 1_000],
      ]),
    );
    const undersized = turnVirtualWindowForRange(layout, 4, 5);
    const recovered = stableTurnVirtualWindowForViewport(
      layout,
      undersized,
      { scrollTop: 5_000, clientHeight: 800 },
    );

    assert.deepEqual([recovered.start, recovered.end], [0, 10]);
    assert.deepEqual(
      stableTurnVirtualWindowForViewport(
        layout,
        recovered,
        { scrollTop: 5_000, clientHeight: 800 },
      ),
      recovered,
    );
  });

  it('brings an explicit target into the bounded window', () => {
    const turnIds = ids(1_000);
    const layout = buildTurnVirtualLayout(turnIds, undefined);
    const tail = initialTurnVirtualWindow(layout, 40);
    const target = reconcileTurnVirtualWindow(turnIds, layout, tail, 10);
    assert.ok(target.start <= 10 && target.end > 10);
    assert.ok(target.end - target.start <= 100);
  });

  it('keeps the viewport bounded when a retained turn is too far away', () => {
    const layout = buildTurnVirtualLayout(ids(1_000), undefined, { estimatedHeight: 100 });
    const window = turnVirtualWindowForViewport(
      layout,
      { scrollTop: 80_000, clientHeight: 800 },
      { maxTurns: 100, ensureIndex: 10 },
    );
    assert.equal(window.end - window.start, 100);
    assert.ok(layout.offsets[window.start]! <= 80_000);
    assert.ok(layout.offsets[window.end]! >= 80_800);
  });
});
