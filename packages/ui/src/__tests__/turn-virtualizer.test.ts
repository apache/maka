import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildTurnVirtualLayout,
  initialTurnVirtualWindow,
  reconcileTurnVirtualWindow,
  stableTurnVirtualWindowForViewport,
  turnVirtualWindowForRange,
  turnVirtualWindowForViewport,
} from '../turn-virtualizer.js';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `t${index}`);

describe('turn virtualizer', () => {
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
    const layout = buildTurnVirtualLayout(ids(120), undefined, { estimatedHeight: 200 });
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

  it('keeps the same visible identities across prepends and follows tail appends', () => {
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
    const appended = [...beforeIds, 't100'];
    const afterAppend = reconcileTurnVirtualWindow(
      beforeIds,
      buildTurnVirtualLayout(appended, undefined),
      tail,
    );
    assert.equal(afterAppend.end, appended.length);
    assert.equal(afterAppend.end - afterAppend.start, 40);
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
