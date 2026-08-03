import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInvocationSource } from '../invocation-context.js';

test('accepts gateway activations as a runtime invocation source', () => {
  assert.equal(isInvocationSource('gateway'), true);
});
