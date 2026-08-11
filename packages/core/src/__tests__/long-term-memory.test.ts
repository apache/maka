import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  isMemoryItemKind,
  isMemoryKeyType,
  normalizeLongTermMemoryContent,
  validateMemoryTemporalBounds,
} from '../long-term-memory.js';

describe('long-term memory contract', () => {
  test('validates temporal bounds without deriving a relative status', () => {
    assert.doesNotThrow(() =>
      validateMemoryTemporalBounds({
        temporalType: 'undated',
        eventStartedAt: null,
        eventEndedAt: null,
      }),
    );
    assert.doesNotThrow(() =>
      validateMemoryTemporalBounds({
        temporalType: 'point',
        eventStartedAt: 100,
        eventEndedAt: null,
      }),
    );
    assert.doesNotThrow(() =>
      validateMemoryTemporalBounds({
        temporalType: 'interval',
        eventStartedAt: 100,
        eventEndedAt: 200,
      }),
    );
    assert.doesNotThrow(() =>
      validateMemoryTemporalBounds({
        temporalType: 'open_ended',
        eventStartedAt: 100,
        eventEndedAt: null,
      }),
    );
  });

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

  test('keeps provisional categories and key types closed', () => {
    assert.equal(isMemoryItemKind('preference'), true);
    assert.equal(isMemoryItemKind('misc'), false);
    assert.equal(isMemoryKeyType('code'), true);
    assert.equal(isMemoryKeyType('keyword'), false);
  });

});
