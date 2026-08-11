import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createTurnSizeIndex,
  layoutKeyOf,
  measureSettledGeometry,
  measureTurnGeometry,
  prefixHeightFor,
} from '../turn-size-index.js';

function geometry(heights: Record<string, number>, gap = 4) {
  return { heights: new Map(Object.entries(heights)), gap };
}

function fakeRoot(options: {
  warmup?: string;
  width?: number;
  columnWidth?: number;
  turns?: Array<{ id: string; top: number; height: number; streaming?: boolean }>;
}) {
  return {
    clientWidth: options.width ?? 900,
    dataset: { turnWarmup: options.warmup, density: 'balanced' },
    querySelector: () =>
      options.columnWidth === undefined ? null : { clientWidth: options.columnWidth },
    querySelectorAll: () =>
      (options.turns ?? []).map((turn) => ({
        hasAttribute: (name: string) => name === 'data-live-streaming' && (turn.streaming ?? false),
        getAttribute: (name: string) => (name === 'data-turn-id' ? turn.id : null),
        getBoundingClientRect: () => ({ top: turn.top, height: turn.height }),
      })),
  };
}

describe('createTurnSizeIndex', () => {
  it('drops the oldest session past capacity', () => {
    const index = createTurnSizeIndex(2);
    index.record('s1', 'k', geometry({ a: 1 }));
    index.record('s2', 'k', geometry({ a: 1 }));
    index.record('s3', 'k', geometry({ a: 1 }));
    assert.equal(index.lookup('s1', 'k'), undefined);
    assert.ok(index.lookup('s2', 'k'));
    assert.ok(index.lookup('s3', 'k'));
  });
});

describe('prefixHeightFor', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('is undefined when any prefix turn lacks a height', () => {
    assert.equal(prefixHeightFor(ids, 2, geometry({ a: 100 })), undefined);
  });

  it('sums the prefix turns plus the gaps between them', () => {
    // Two turns and the one gap between them; the gap joining the spacer to
    // the first mounted turn belongs to the list.
    assert.equal(prefixHeightFor(ids, 2, geometry({ a: 100, b: 250.5 }, 4)), 355);
  });
});

describe('measureSettledGeometry', () => {
  const turns = [
    { id: 'a', top: 0, height: 100 },
    { id: 'b', top: 104, height: 200 },
  ];

  it('aborts when the layout moved since the key was captured', () => {
    const before = layoutKeyOf(fakeRoot({ width: 900 }));
    const root = fakeRoot({ warmup: 'settled', width: 700, turns });
    assert.deepEqual(measureSettledGeometry(root, before), { status: 'aborted' });
  });

  it('measures a settled transcript and skips live-streaming turns', () => {
    const root = fakeRoot({
      warmup: 'settled',
      turns: [...turns, { id: 'c', top: 308, height: 40, streaming: true }],
    });
    const attempt = measureSettledGeometry(root, layoutKeyOf(root));
    assert.equal(attempt.status, 'measured');
    if (attempt.status === 'measured') {
      assert.equal(attempt.geometry.heights.size, 2);
      assert.equal(attempt.geometry.heights.get('c'), undefined);
      assert.equal(attempt.geometry.gap, 4);
    }
  });
});

describe('measureTurnGeometry', () => {
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
