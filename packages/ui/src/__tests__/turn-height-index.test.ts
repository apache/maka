import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createTurnHeightIndex } from '../turn-height-index.js';

describe('turn height index', () => {
  it('keeps measurements for the current layout and bounds old sessions and turns', () => {
    const index = createTurnHeightIndex(2, 2);
    assert.equal(index.record('s1', 'wide', 'a', 100), true);
    assert.equal(index.record('s1', 'wide', 'a', 100.2), false);
    index.record('s1', 'wide', 'b', 200);
    index.record('s1', 'wide', 'c', 300);
    assert.equal(index.lookup('s1', 'wide')?.has('a'), false);
    index.record('s2', 'wide', 'a', 100);
    index.record('s3', 'wide', 'a', 100);
    assert.equal(index.lookup('s1', 'wide'), undefined);
  });

  it('does not reuse heights after the layout changes', () => {
    const index = createTurnHeightIndex();
    index.record('s1', 'wide', 'a', 100);
    index.record('s1', 'narrow', 'a', 200);
    assert.equal(index.lookup('s1', 'wide'), undefined);
    assert.equal(index.lookup('s1', 'narrow')?.get('a'), 200);
  });
});
