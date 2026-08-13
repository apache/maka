import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateMemoryTemporalBounds } from '../long-term-memory.js';

describe('long-term memory contract', () => {
  test('fails closed over invalid temporal combinations', () => {
    assert.throws(
      () =>
        validateMemoryTemporalBounds({
          temporalType: 'undated',
          eventStartedAt: 1,
          eventEndedAt: null,
        }),
      /cannot carry event bounds/,
    );
    assert.throws(
      () =>
        validateMemoryTemporalBounds({
          temporalType: 'interval',
          eventStartedAt: 100,
          eventEndedAt: null,
        }),
      /requires an end/,
    );
    assert.throws(
      () =>
        validateMemoryTemporalBounds({
          temporalType: 'point',
          eventStartedAt: 200,
          eventEndedAt: 100,
        }),
      /later than its start/,
    );
  });
});
