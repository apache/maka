import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findInputSurfaceRows, inputSurfaceRows } from './tui-terminal-mock.js';

test('input surface lookup distinguishes an intermediate frame from a settled frame', () => {
  const intermediate = ['────────────────'];
  const settled = ['────────────────', 'draft', '────────────────'];

  assert.equal(findInputSurfaceRows(intermediate), undefined);
  assert.deepEqual(findInputSurfaceRows(settled), [0, 2]);
  assert.throws(() => inputSurfaceRows(intermediate));
});
