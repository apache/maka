import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createTurnSizeIndex,
  layoutKeyFor,
  measureTurnGeometry,
  prefixHeightFor,
} from '../turn-size-index.js';

function geometry(heights: Record<string, number>, gap = 4) {
  return { heights: new Map(Object.entries(heights)), gap };
}

describe('createTurnSizeIndex', () => {
  it('returns a record only for the layout it was measured under', () => {
    const index = createTurnSizeIndex();
    index.record('s1', layoutKeyFor(900, 'balanced'), geometry({ a: 100 }));
    assert.ok(index.lookup('s1', layoutKeyFor(900, 'balanced')));
    assert.equal(index.lookup('s1', layoutKeyFor(700, 'balanced')), undefined);
    assert.equal(index.lookup('s1', layoutKeyFor(900, 'compact')), undefined);
    assert.equal(index.lookup('s2', layoutKeyFor(900, 'balanced')), undefined);
  });

  it('drops the oldest session past capacity', () => {
    const index = createTurnSizeIndex(2);
    index.record('s1', 'k', geometry({ a: 1 }));
    index.record('s2', 'k', geometry({ a: 1 }));
    index.record('s3', 'k', geometry({ a: 1 }));
    assert.equal(index.lookup('s1', 'k'), undefined);
    assert.ok(index.lookup('s2', 'k'));
    assert.ok(index.lookup('s3', 'k'));
  });

  it('re-recording refreshes a session instead of evicting it', () => {
    const index = createTurnSizeIndex(2);
    index.record('s1', 'k', geometry({ a: 1 }));
    index.record('s2', 'k', geometry({ a: 1 }));
    index.record('s1', 'k', geometry({ a: 2 }));
    index.record('s3', 'k', geometry({ a: 1 }));
    assert.equal(index.lookup('s2', 'k'), undefined);
    assert.equal(index.lookup('s1', 'k')?.heights.get('a'), 2);
  });

  it('ignores an empty measurement', () => {
    const index = createTurnSizeIndex();
    index.record('s1', 'k', geometry({}));
    assert.equal(index.lookup('s1', 'k'), undefined);
  });
});

describe('prefixHeightFor', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('is zero for a complete transcript', () => {
    assert.equal(prefixHeightFor(ids, 0, geometry({})), 0);
    assert.equal(prefixHeightFor(ids, 0, undefined), 0);
  });

  it('is undefined without a record', () => {
    assert.equal(prefixHeightFor(ids, 2, undefined), undefined);
  });

  it('is undefined when any prefix turn lacks a height', () => {
    assert.equal(prefixHeightFor(ids, 2, geometry({ a: 100 })), undefined);
  });

  it('sums the prefix turns plus the gaps between them', () => {
    // Two turns and the one gap between them; the gap joining the spacer to
    // the first mounted turn belongs to the list.
    assert.equal(prefixHeightFor(ids, 2, geometry({ a: 100, b: 250.5 }, 4)), 355);
  });
});

describe('measureTurnGeometry', () => {
  it('needs at least one adjacent pair to learn the gap', () => {
    assert.equal(measureTurnGeometry([]), undefined);
    assert.equal(measureTurnGeometry([{ turnId: 'a', top: 0, height: 100 }]), undefined);
  });

  it('records heights and the median between-turn gap', () => {
    const record = measureTurnGeometry([
      { turnId: 'a', top: 0, height: 100 },
      { turnId: 'b', top: 104, height: 200 },
      { turnId: 'c', top: 308, height: 50 },
    ]);
    assert.ok(record);
    assert.equal(record.gap, 4);
    assert.equal(record.heights.get('b'), 200);
  });

  it('rejects a negative gap reading', () => {
    assert.equal(
      measureTurnGeometry([
        { turnId: 'a', top: 0, height: 100 },
        { turnId: 'b', top: 90, height: 200 },
      ]),
      undefined,
    );
  });
});
